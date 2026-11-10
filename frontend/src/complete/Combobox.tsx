import { useEffect, useId, useState } from "react";
import { rank, type Candidate } from "./complete";

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Enter: called with the final value (the active suggestion or the typed text). */
  onSubmit?: (v: string) => void;
  /** Removes a removable candidate (its ✕). */
  onRemove?: (c: Candidate) => void;
  /** Enter on a highlighted suggestion that differs from the text only accepts it; the next Enter submits (as the port-forward dialog). */
  enterAccepts?: boolean;
  /** An accepted value that is only a step (a field path ending in "."): the list stays open for the next one, nothing preselected. Deleting a step's last character (⌫ on the ".") closes the list, so Enter submits the value as typed. */
  continues?: (v: string) => boolean;
  candidates: Candidate[];
  /** Shown under the list (loading, partial discovery, errors). */
  hint?: string;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * Free-text input with ranked suggestions (WAI-ARIA combobox). Free text
 * always submits as typed: the best match is preselected only if it is a
 * real (non-fuzzy) match, and nothing is preselected for empty input.
 *
 * Focus selects the value, so typing replaces it. The list opens on typing
 * (or ↓ to browse: every candidate while the value is still untouched, since
 * typing would replace it anyway; ranked by the text once typed). Keys: ↓/↑
 * (also ctrl+n/p) move, ⌥↑/⌥↓ first/last, Tab accepts and stays, Enter
 * accepts and submits (with enterAccepts: a highlighted suggestion is only
 * accepted and the list closed, the next Enter submits; a value that continues
 * keeps the list open instead), Esc closes the list (a second
 * Esc reaches the dialog). Removable entries (history) have a ✕, mouse only:
 * keys like ⌫ are typing here.
 */
export function Combobox({ label, value, onChange, onSubmit, enterAccepts, continues, onRemove, candidates, hint, placeholder, autoFocus, className }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // -1 = nothing active: Enter submits the typed text
  const [active, setActive] = useState(-1);
  // the value as it was when focused (prefilled or accepted): ↓ then browses everything
  const [typed, setTyped] = useState(false);
  // a continuing value was just accepted: its next step starts empty, so nothing is preselected (as for empty input)
  const [stepped, setStepped] = useState(false);
  const matches = open ? rank(typed ? value : "", candidates, 50) : [];
  const preselect = (q: string) => {
    const m = rank(q, candidates, 1)[0];
    return q.trim() && m && !m.fuzzy && !m.candidate.disabled ? 0 : -1;
  };
  // candidates can arrive after the typing (the catalog loads in the background): preselect
  // when they do (keyed on their count: callers pass a new array each render, and a
  // deliberate "nothing selected" must stay)
  const loaded = candidates.length;
  useEffect(() => {
    if (typed && open && active < 0 && !stepped) setActive(preselect(value));
  }, [loaded]);
  const accept = (c: Candidate) => {
    if (c.disabled) return; // shown with its reason, can't be picked
    // a step (e.g. "spec."): the list stays open, ranked by the new value, for the next one
    const more = !!continues?.(c.value);
    onChange(c.value);
    setOpen(more);
    setActive(-1);
    setTyped(more);
    setStepped(more);
  };
  const move = (d: number) => {
    if (!open) return setOpen(true), setActive(0);
    const n = matches.length;
    if (n) setActive((a) => (a < 0 ? (d > 0 ? 0 : n - 1) : (a + d + n) % n));
  };
  const cur = active >= 0 ? matches[active] : undefined;

  return (
    <div className="relative">
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open && matches.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={cur ? `${id}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className={className}
        value={value}
        // typing replaces the previous value (a mouse click still places the caret)
        onFocus={(e) => {
          e.currentTarget.select();
          setTyped(false);
          setStepped(false);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next);
          setTyped(true);
          setStepped(false);
          // ⌫ on a step's final "." (spec. → spec) stops there: the list closes, so Enter submits the
          // text rather than taking the step again (↓ or typing on opens it again)
          const backedOff = !!continues?.(value) && !continues(next) && next === value.slice(0, -1);
          setOpen(!backedOff);
          setActive(backedOff ? -1 : preselect(next));
        }}
        onKeyDown={(e) => {
          const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && open && matches.length) {
            // ⌥↑/⌥↓: first/last suggestion (closed list: caret to start/end as usual)
            e.preventDefault();
            setActive(e.key === "ArrowUp" ? 0 : matches.length - 1);
          } else if (e.key === "ArrowDown" || (ctrl && e.key === "n")) {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp" || (ctrl && e.key === "p")) {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Tab" && !e.shiftKey && open && (cur ?? matches.find((m) => !m.candidate.disabled))) {
            // Tab completes to the active (or best pickable) match and stays in the field
            e.preventDefault();
            accept((cur ?? matches.find((m) => !m.candidate.disabled))!.candidate);
          } else if (e.key === "Enter" && (enterAccepts || continues?.(cur?.candidate.value ?? "")) && cur && !cur.candidate.disabled) {
            // a highlighted suggestion is only taken (and the list closed); the next Enter, with
            // nothing showing, submits — even when the suggestion already equals the field's text.
            // A continuing one is only taken, enterAccepts or not: it's not a value to submit yet
            e.preventDefault();
            accept(cur.candidate);
          } else if (e.key === "Enter" && onSubmit) {
            e.preventDefault();
            const v = cur && !cur.candidate.disabled ? cur.candidate.value : value;
            if (cur) accept(cur.candidate);
            else setOpen(false);
            onSubmit(v);
          } else if (e.key === "Escape" && open && matches.length) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={`${label} suggestions`}
          // at least as wide as the field, wider for long details (narrow fields), never scrolling sideways
          className="absolute top-full left-0 z-40 mt-px max-h-64 w-max max-w-[min(32rem,90vw)] min-w-full overflow-x-hidden overflow-y-auto border border-border bg-bg-elev shadow-menu"
        >
          {matches.map((m, i) => (
            <li
              key={`${m.candidate.value}\u0000${m.candidate.label}`}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={m.candidate.disabled ? true : undefined}
              title={m.candidate.disabled}
              ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              // mousedown, not click: keep focus in the input
              onMouseDown={(e) => {
                e.preventDefault();
                accept(m.candidate);
              }}
              onMouseMove={() => setActive(i)}
              className={`flex cursor-default justify-between gap-3 px-2 py-0.5 ${i === active ? "bg-bg-hover text-fg" : "text-fg-muted"} ${m.candidate.disabled ? "opacity-50" : ""}`}
            >
              {/* the name is what's picked: the detail gives way first (much higher shrink weight) */}
              <span className="min-w-0 shrink truncate text-fg">{highlight(m.candidate.label, m.hits)}</span>
              {m.candidate.detail && <span className="min-w-0 shrink-[1000] truncate">{highlight(m.candidate.detail, m.detailHits)}</span>}
              {m.candidate.disabled ? <span className="shrink-0 italic">{m.candidate.disabled}</span> : null}
              {m.candidate.removable && onRemove ? (
                // mousedown, like the option itself: the input keeps focus and the list stays open
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`remove ${m.candidate.label}`}
                  title="remove"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemove(m.candidate);
                  }}
                  className="ml-auto shrink-0 rounded border border-border px-1.5 leading-tight text-fg-muted hover:border-deleted hover:text-deleted"
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {hint && (
        <div role="status" aria-label={`${label} completion status`} className="mt-0.5 text-fg-muted">
          {hint}
        </div>
      )}
    </div>
  );
}

function highlight(text: string, hits: number[]) {
  if (!hits.length) return text;
  const set = new Set(hits);
  return [...text].map((ch, i) =>
    set.has(i) ? (
      <b key={i} className="font-normal text-accent">
        {ch}
      </b>
    ) : (
      ch
    ),
  );
}
