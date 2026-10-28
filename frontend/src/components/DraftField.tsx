import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Suggestions, useFieldCompletion } from "../complete/useFieldCompletion";
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
  /** After ⏎ applied the draft (not when it was refused, nor on leaving the field), and after Esc. */
  onDone: () => void;
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
 * ⏎ or leaving the field applies it; ⏎ also goes back to the list.
 * Esc drops the draft (the applied value comes back) and goes back to the list.
 * The CEL field completes field paths from the live objects, and the
 * operators that fit a field's type after it; the label field the objects'
 * label keys and values. ↓ opens the suggestions at the caret.
 */
export const DraftField = forwardRef<HTMLInputElement, Props>(function DraftField(
  { field, label, placeholder, applied, serverId, focused, onApply, onDone, onFocus, onBlur, className },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!);
  const [draft, setDraft] = useState(applied);
  // the dry run and the draft it was computed for (it lags the typing by the debounce)
  const [result, setResult] = useState<{ draft: string; preview: Preview }>();
  const preview = result?.draft === draft ? result.preview : undefined;
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

  // completion: field keys from Go (per path), plus CEL functions; operators after an operand.
  // Labels: the objects' label keys, a key's values
  const { list, accept, onKeyDown: completionKeys, trackCaret, close } = useFieldCompletion({ input, value: draft, setValue: setDraft, serverId, enabled: focused, syntax: cel ? "cel" : "labels" });

  const apply = async () => {
    // ⏎ may beat the debounced dry run: check this exact draft first
    let p = preview;
    if (pending && draft.trim() && !p && serverId) p = await bridge().preview(serverId, { field, value: draft }).catch(() => undefined);
    if (p?.invalid && pending && draft.trim()) {
      setResult({ draft, preview: p });
      return false; // refused: the reason is shown
    }
    if (cel) remember(draft);
    onApply(draft.trim());
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // ↑ in an empty CEL field without suggestions: recent filters, then ↑/↓ through them (↓ otherwise opens the suggestions)
    const recall = cel && !list && recent.length && (e.key === "ArrowUp" ? history >= 0 || !draft : e.key === "ArrowDown" && history >= 0);
    if (!recall && completionKeys(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      return void apply().then((ok) => ok && onDone());
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDraft(applied); // nothing pending: leaving the field won't apply it
      setResult(undefined);
      setHistory(-1);
      return onDone();
    }
    if (recall) {
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
        aria-autocomplete="list"
        aria-expanded={!!list}
        data-revert
        title={!focused && draft ? (status ? `${draft}\n${status}` : draft) : undefined}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          trackCaret(e.target);
          setHistory(-1);
        }}
        onSelect={(e) => trackCaret(e.currentTarget)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={(e) => {
          close();
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
      {list ? <Suggestions list={list} accept={accept} label={cel ? "cel suggestions" : "label suggestions"} /> : null}
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
