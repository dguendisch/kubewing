import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { bridge, paneData } from "../store/store";
import type { FieldKeys, LabelCounts } from "../transport/types";
import { celContext, celGlobals, keyCandidates, operatorCandidates } from "./cel";
import { rank, type Candidate, type Match } from "./complete";
import { labelCandidates, labelContext, labelOperators } from "./labels";

export interface CompletionList {
  matches: Match[];
  from: number;
  active: number;
}

/**
 * Completion for a text field over a pane's live objects. CEL (over `o`):
 * field keys from Go (per path; cached until the object count changes), CEL
 * globals and functions, and after an operand the operators that fit its
 * type. A label selector: the objects' label keys, the operators after a
 * key and a space, and a key's values after `=`, `!=` or in `in (…)`; among
 * the source's objects matching the selector's other requirements, so the
 * applied selector doesn't limit them (Go lists what the pane doesn't hold).
 * The list opens as you type where there is something to complete, and on
 * ↓ anywhere (with the first entry highlighted: an empty field lists
 * everything that can start it). The caller owns the value; onKeyDown
 * handles ↓ to open, ↑/↓, Tab and ⏎ on a highlighted entry and Esc while
 * the list is open, and reports whether it did (the caller's own keys come
 * after).
 */
export function useFieldCompletion({
  input,
  value,
  setValue,
  serverId,
  enabled,
  syntax = "cel",
}: {
  input: RefObject<HTMLInputElement | null>;
  value: string;
  setValue: (v: string) => void;
  serverId?: string;
  enabled: boolean;
  syntax?: "cel" | "labels";
}) {
  const [tracked, setCaret] = useState(0);
  // a value set from elsewhere (Esc putting the applied one back, a jump) may be shorter than where the caret was
  const caret = Math.min(tracked, value.length);
  const [list, setList] = useState<CompletionList>();
  // ↓ asked for the list at this text and caret (typing on goes back to opening on its own)
  const [asked, setAsked] = useState<{ value: string; caret: number }>();

  // the cached keys follow the live objects
  const [objects, setObjects] = useState(0);
  useEffect(() => {
    if (!serverId) return;
    setObjects(paneData.get(serverId).status.objects);
    return paneData.subscribe(serverId, (d) => setObjects(d.status.objects));
  }, [serverId]);
  const keys = useRef(new Map<string, Promise<FieldKeys | undefined>>());
  const fieldKeys = (id: string, path: string[]) => {
    const k = JSON.stringify(path);
    return keys.current.get(k) ?? keys.current.set(k, bridge().fieldKeys(id, path).catch(() => undefined)).get(k)!;
  };
  const labelSets = useRef(new Map<string, Promise<LabelCounts | undefined>>());
  const labels = (id: string, key: string, others: string) => {
    const k = JSON.stringify([key, others]);
    return labelSets.current.get(k) ?? labelSets.current.set(k, bridge().labels(id, key, others).catch(() => undefined)).get(k)!;
  };
  useEffect(() => {
    keys.current.clear();
    labelSets.current.clear();
  }, [serverId, objects]);

  /** The context at the caret and its candidates; undefined = nothing to complete there. */
  const candidates = (id: string, explicit: boolean): { from: number; word: string; cands: Promise<Candidate[]> } | undefined => {
    if (syntax === "labels") {
      const ctx = labelContext(value, caret);
      // a key opens the list once typed, a value or operator right away
      if (!ctx || (ctx.at === "key" && !ctx.word && !explicit)) return undefined;
      const cands =
        ctx.at === "operator"
          ? Promise.resolve(labelOperators)
          : labels(id, ctx.at === "key" ? "" : ctx.key!, ctx.others).then((f) => labelCandidates(f, ctx.listed));
      return { from: ctx.from, word: ctx.word, cands };
    }
    const ctx = celContext(value, caret);
    if (!ctx || (!ctx.word && ctx.path === undefined && !ctx.operator && !explicit)) return undefined;
    const op = ctx.operator;
    // the left operand's type: its key's entry at the parent path
    const key = op?.path?.at(-1);
    const cands = op
      ? key === undefined
        ? Promise.resolve(operatorCandidates(op))
        : fieldKeys(id, op.path!.slice(0, -1)).then((f) => operatorCandidates(op, f?.keys.find((k) => k.key === key)?.type))
      : ctx.path === undefined
        ? Promise.resolve(celGlobals)
        : fieldKeys(id, ctx.path).then((f) => keyCandidates(f, ctx));
    return { from: ctx.from, word: ctx.word, cands };
  };

  // bumped by Esc: a lookup still pending then must not reopen the list it closed
  const dismissed = useRef(0);
  useEffect(() => {
    if (!enabled || !serverId) return setList(undefined);
    const explicit = asked?.value === value && asked.caret === caret;
    const at = candidates(serverId, explicit);
    if (!at) return setList(undefined);
    let live = true;
    const gen = dismissed.current;
    void at.cands.then((cands) => {
      if (!live || gen !== dismissed.current) return;
      const matches = rank(at.word, cands, 30);
      // nothing more to add when the text is complete (an operator's value adds a space), unless asked for
      const typed = value.slice(at.from, caret);
      if (!matches.length || (!explicit && matches.length === 1 && matches[0]!.candidate.value.trimEnd() === typed)) return setList(undefined);
      setList({ matches, from: at.from, active: explicit || (at.word && !matches[0]!.fuzzy) ? 0 : -1 });
    });
    return () => void (live = false);
  }, [value, caret, enabled, serverId, syntax, asked]);

  // the caret after an accept, placed as soon as the new value is in the DOM: a later
  // frame could land after the next keys (typing on after `!= `) and move it back
  const place = useRef<number>(undefined);
  useLayoutEffect(() => {
    if (place.current === undefined) return;
    input.current?.setSelectionRange(place.current, place.current);
    place.current = undefined;
  });
  const accept = (c: Candidate) => {
    if (!list) return;
    const next = value.slice(0, list.from) + c.value + value.slice(caret);
    const at = list.from + c.value.length;
    place.current = at;
    setValue(next);
    setCaret(at);
    setList(undefined);
    setAsked(undefined);
  };

  /** The list's keys; true if the key was handled (the caller skips its own handling). */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    const n = list?.matches.length ?? 0;
    if ((!list || !n) && e.key === "ArrowDown" && !e.altKey && !e.metaKey && enabled && serverId) {
      // ↓ opens the list at the caret (the caret may not be tracked yet: a value set from elsewhere)
      const el = e.currentTarget;
      const at = el.selectionStart ?? el.value.length;
      if (el.selectionEnd !== at) return false;
      e.preventDefault();
      setCaret(at);
      setAsked({ value, caret: at });
      return true;
    }
    if (!list || !n) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setList({ ...list, active: list.active < 0 ? (d > 0 ? 0 : n - 1) : (list.active + d + n) % n });
      return true;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      accept(list.matches[Math.max(0, list.active)]!.candidate);
      return true;
    }
    if (e.key === "Enter" && list.active >= 0) {
      e.preventDefault();
      accept(list.matches[list.active]!.candidate);
      return true;
    }
    if (e.key === "Escape") {
      // the list closes first; a second Esc reaches the field's owner
      e.preventDefault();
      e.stopPropagation();
      // (asked stays: clearing it would run the lookup again and reopen the list)
      dismissed.current++;
      setList(undefined);
      return true;
    }
    return false;
  };

  /** Props for the input: caret tracking (onChange must also call trackCaret). */
  const trackCaret = (el: HTMLInputElement) => setCaret(el.selectionStart ?? el.value.length);
  const close = () => {
    setList(undefined);
    setAsked(undefined);
  };
  return { list, accept, onKeyDown, trackCaret, close };
}

/** The suggestion list under a field completed by useFieldCompletion. */
export function Suggestions({ list, accept, label }: { list: CompletionList; accept: (c: Candidate) => void; label: string }) {
  return (
    <ul role="listbox" aria-label={label} className="absolute top-full left-0 z-40 mt-px max-h-64 min-w-64 overflow-y-auto border border-border bg-bg-elev">
      {list.matches.map((m, i) => (
        <li
          key={m.candidate.value + m.candidate.label}
          role="option"
          aria-selected={i === list.active}
          ref={i === list.active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
          onMouseDown={(e) => {
            e.preventDefault();
            accept(m.candidate);
          }}
          className={`flex justify-between gap-3 px-2 py-0.5 ${i === list.active ? "bg-bg-hover text-fg" : "text-fg-muted"}`}
        >
          <span className="text-fg">{m.candidate.label}</span>
          {m.candidate.detail ? <span className="shrink-0">{m.candidate.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}
