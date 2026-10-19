import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { celContext, celFunctions, celGlobals, fieldCandidates } from "../complete/cel";
import { rank, type Candidate, type Match } from "../complete/complete";
import { bridge, paneData } from "../store/store";
import type { Preview } from "../transport/types";

interface Props {
  field: "filter" | "labels";
  label: string;
  placeholder: string;
  /** The applied value (pane spec). */
  applied: string;
  serverId?: string;
  focused: boolean;
  onApply: (v: string) => void;
  onFocus: () => void;
  onBlur: (e: React.FocusEvent) => void;
  className: string;
}

/** Recent CEL filters, newest first (session only). */
const recent: string[] = [];
const remember = (v: string) => {
  if (!v.trim()) return;
  const i = recent.indexOf(v);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(v);
  if (recent.length > 20) recent.pop();
};

/**
 * A filter bar field that holds a draft until ⏎: a label selector or CEL
 * filter that is valid but half-typed (`app=et`, `phase == "Run"`) would
 * otherwise blank the table on every keystroke. While typing, Go dry-runs
 * the draft against the pane's objects and the field shows the outcome.
 * ⏎ or leaving the field applies it.
 * The CEL field completes field paths from the live objects.
 */
export const DraftField = forwardRef<HTMLInputElement, Props>(function DraftField(
  { field, label, placeholder, applied, serverId, focused, onApply, onFocus, onBlur, className },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!);
  const [draft, setDraft] = useState(applied);
  // the dry run and the draft it was computed for (it lags the typing by the debounce)
  const [result, setResult] = useState<{ draft: string; preview: Preview }>();
  const preview = result?.draft === draft ? result.preview : undefined;
  const [caret, setCaret] = useState(0);
  const [list, setList] = useState<{ matches: Match[]; from: number; active: number }>();
  const [history, setHistory] = useState(-1);
  const pending = draft !== applied;
  const cel = field === "filter";

  // an apply from elsewhere (= / ! in the detail view) replaces the draft
  useEffect(() => setDraft(applied), [applied]);

  // the count follows the live objects: re-run on object count changes too
  const [objects, setObjects] = useState(0);
  useEffect(() => {
    if (!serverId) return;
    setObjects(paneData.get(serverId).status.objects);
    return paneData.subscribe(serverId, (d) => setObjects(d.status.objects));
  }, [serverId]);
  useEffect(() => {
    if (!serverId || !pending) return setResult(undefined);
    let live = true;
    const t = setTimeout(() => {
      bridge()
        .preview(serverId, { field, value: draft })
        .then((p) => live && setResult({ draft, preview: p }), () => live && setResult(undefined));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [draft, serverId, pending, objects]);

  // completion: field keys from Go (per path), plus CEL functions
  const keys = useRef(new Map<string, Promise<Candidate[]>>());
  useEffect(() => keys.current.clear(), [serverId, objects]);
  useEffect(() => {
    if (!cel || !focused || !serverId) return setList(undefined);
    const ctx = celContext(draft, caret);
    if (!ctx || (!ctx.word && ctx.path === undefined)) return setList(undefined);
    let live = true;
    const fields =
      ctx.path === undefined
        ? Promise.resolve(celGlobals)
        : (keys.current.get(ctx.path) ??
          keys.current
            .set(
              ctx.path,
              bridge()
                .fieldKeys(serverId, ctx.path)
                .then(fieldCandidates, () => []),
            )
            .get(ctx.path)!
        ).then((f) => [...f, ...(ctx.path ? celFunctions : [])]);
    void fields.then((cands) => {
      if (!live) return;
      const matches = rank(ctx.word, cands, 30);
      // nothing more to add when the word is complete
      if (!matches.length || (matches.length === 1 && matches[0]!.candidate.value === ctx.word)) return setList(undefined);
      setList({ matches, from: ctx.from, active: ctx.word && !matches[0]!.fuzzy ? 0 : -1 });
    });
    return () => void (live = false);
  }, [draft, caret, focused, serverId, cel]);

  const accept = (c: Candidate) => {
    if (!list) return;
    const next = draft.slice(0, list.from) + c.value + draft.slice(caret);
    const at = list.from + c.value.length;
    setDraft(next);
    setList(undefined);
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(at, at);
      setCaret(at);
    });
  };

  const apply = async () => {
    // ⏎ may beat the debounced dry run: check this exact draft first
    let p = preview;
    if (pending && draft.trim() && !p && serverId) p = await bridge().preview(serverId, { field, value: draft }).catch(() => undefined);
    if (p?.invalid && pending && draft.trim()) {
      setResult({ draft, preview: p });
      return; // refused: the reason is shown
    }
    if (cel) remember(draft);
    onApply(draft.trim());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = list?.matches.length ?? 0;
    if (list && n && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      return setList({ ...list, active: list.active < 0 ? (d > 0 ? 0 : n - 1) : (list.active + d + n) % n });
    }
    if (list && n && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      return accept(list.matches[Math.max(0, list.active)]!.candidate);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (list && list.active >= 0) return accept(list.matches[list.active]!.candidate);
      return void apply();
    }
    if (e.key === "Escape" && list) {
      // the list closes first; a second Esc leaves the field (keymap)
      e.preventDefault();
      e.stopPropagation();
      return setList(undefined);
    }
    // ↑/↓ in a CEL field without suggestions: recent filters
    if (cel && !list && (e.key === "ArrowUp" || e.key === "ArrowDown") && recent.length && (history >= 0 || !draft)) {
      e.preventDefault();
      const h = Math.max(-1, Math.min(recent.length - 1, history + (e.key === "ArrowUp" ? 1 : -1)));
      setHistory(h);
      setDraft(h < 0 ? "" : recent[h]!);
    }
  };

  const status = pending ? describe(preview) : undefined;
  const wide = cel && focused;
  return (
    <div className={`relative ${wide ? "min-w-0 flex-1" : ""}`}>
      <input
        ref={input}
        aria-label={label}
        aria-invalid={!!preview?.invalid && pending}
        aria-autocomplete={cel ? "list" : undefined}
        aria-expanded={cel ? !!list : undefined}
        title={!focused && draft ? (status ? `${draft}\n${status}` : draft) : undefined}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setHistory(-1);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={(e) => {
          setList(undefined);
          // leaving the field applies it, like ⏎ (an invalid draft stays, marked red);
          // the window losing focus (app switch) is not leaving the field
          if (pending && document.hasFocus()) void apply();
          onBlur(e);
        }}
        className={`${className} ${wide ? "w-full" : ""} ${pending ? "border-dashed" : ""} ${preview?.invalid && pending ? "border-deleted" : ""}`}
      />
      {/* while suggestions are open the draft is mid-word: its status would only cover the list */}
      {/* unfocused, a pending draft shows only as the dashed (or red) border, with the status as tooltip */}
      {status && focused && !list ? (
        <div
          role="status"
          aria-label={`${field === "filter" ? "cel" : "labels"} draft`}
          className={`absolute top-full right-0 z-30 mt-px whitespace-nowrap border border-border bg-bg-elev px-1 ${preview?.invalid ? "text-deleted" : "text-fg-muted"}`}
        >
          {preview?.invalid && preview.column >= 0 ? <Caret text={draft} column={preview.column} /> : null}
          {status}
        </div>
      ) : null}
      {list ? (
        <ul role="listbox" aria-label="cel suggestions" className="absolute top-full left-0 z-40 mt-px max-h-64 min-w-64 overflow-y-auto border border-border bg-bg-elev">
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
      ) : null}
    </div>
  );
});

/** The draft's outcome: "→ 298 / 340 · ⏎ apply", or why it can't be applied. */
function describe(p: Preview | undefined): string {
  if (!p) return "⏎ to apply";
  if (p.invalid) return p.error ?? "invalid";
  const count = `→ ${p.atLeast ? "≥ " : ""}${p.matched} / ${p.objects}`;
  const errs = p.errors ? ` · ${p.errors} error${p.errors > 1 ? "s" : ""}: ${p.error}` : "";
  return `${count}${errs} · ⏎ apply`;
}

/** The draft with a caret under the parse error position. */
function Caret({ text, column }: { text: string; column: number }) {
  return (
    <div aria-hidden className="whitespace-pre text-fg-muted">
      {text}
      {"\n"}
      <span className="text-deleted">{" ".repeat(Math.min(column, text.length))}^</span>
    </div>
  );
}
