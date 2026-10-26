import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { bridge, paneData } from "../store/store";
import type { FieldKeys } from "../transport/types";
import { celContext, celGlobals, keyCandidates, operatorCandidates } from "./cel";
import { rank, type Candidate, type Match } from "./complete";

export interface CelList {
  matches: Match[];
  from: number;
  active: number;
}

/**
 * CEL completion for a text field over a pane's live objects (`o`): field
 * keys from Go (per path; cached until the object count changes), CEL
 * globals and functions, and after an operand the operators that fit its
 * type. The caller owns the value; onKeyDown handles ↑/↓, Tab and ⏎ on a
 * highlighted entry and Esc while the list is open, and reports whether it
 * did (the caller's own keys come after).
 */
export function useCelCompletion({ input, value, setValue, serverId, enabled }: { input: RefObject<HTMLInputElement | null>; value: string; setValue: (v: string) => void; serverId?: string; enabled: boolean }) {
  const [caret, setCaret] = useState(0);
  const [list, setList] = useState<CelList>();

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
  useEffect(() => keys.current.clear(), [serverId, objects]);

  useEffect(() => {
    if (!enabled || !serverId) return setList(undefined);
    const ctx = celContext(value, caret);
    if (!ctx || (!ctx.word && ctx.path === undefined && !ctx.operator)) return setList(undefined);
    let live = true;
    const op = ctx.operator;
    // the left operand's type: its key's entry at the parent path
    const key = op?.path?.at(-1);
    const cands = op
      ? key === undefined
        ? Promise.resolve(operatorCandidates(op))
        : fieldKeys(serverId, op.path!.slice(0, -1)).then((f) => operatorCandidates(op, f?.keys.find((k) => k.key === key)?.type))
      : ctx.path === undefined
        ? Promise.resolve(celGlobals)
        : fieldKeys(serverId, ctx.path).then((f) => keyCandidates(f, ctx));
    void cands.then((cands) => {
      if (!live) return;
      const matches = rank(ctx.word, cands, 30);
      // nothing more to add when the text is complete (an operator's value adds a space)
      const typed = value.slice(ctx.from, caret);
      if (!matches.length || (matches.length === 1 && matches[0]!.candidate.value.trimEnd() === typed)) return setList(undefined);
      setList({ matches, from: ctx.from, active: ctx.word && !matches[0]!.fuzzy ? 0 : -1 });
    });
    return () => void (live = false);
  }, [value, caret, enabled, serverId]);

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
  };

  /** The list's keys; true if the key was handled (the caller skips its own handling). */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    const n = list?.matches.length ?? 0;
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
      setList(undefined);
      return true;
    }
    return false;
  };

  /** Props for the input: caret tracking (onChange must also call trackCaret). */
  const trackCaret = (el: HTMLInputElement) => setCaret(el.selectionStart ?? el.value.length);
  return { list, accept, onKeyDown, trackCaret, close: () => setList(undefined) };
}

/** The suggestion list under a field completed by useCelCompletion. */
export function CelSuggestions({ list, accept, label = "cel suggestions" }: { list: CelList; accept: (c: Candidate) => void; label?: string }) {
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
