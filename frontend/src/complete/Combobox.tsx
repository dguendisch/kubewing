import { useId, useState } from "react";
import { rank, type Candidate } from "./complete";

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Enter: called with the final value (the active suggestion or the typed text). */
  onSubmit?: (v: string) => void;
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
 * (or ↓ to browse). Keys: ↓/↑ (also ctrl+n/p) move, ⌥↑/⌥↓ first/last, Tab
 * accepts and stays, Enter accepts and submits, Esc closes the list (a
 * second Esc reaches the dialog).
 */
export function Combobox({ label, value, onChange, onSubmit, candidates, hint, placeholder, autoFocus, className }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // -1 = nothing active: Enter submits the typed text
  const [active, setActive] = useState(-1);
  const matches = open ? rank(value, candidates, 50) : [];
  const preselect = (q: string) => {
    const m = rank(q, candidates, 1)[0];
    return q.trim() && m && !m.fuzzy ? 0 : -1;
  };
  const accept = (c: Candidate) => {
    onChange(c.value);
    setOpen(false);
    setActive(-1);
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
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(preselect(e.target.value));
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
          } else if (e.key === "Tab" && !e.shiftKey && open && (cur ?? matches[0])) {
            // Tab completes to the active (or best) match and stays in the field
            e.preventDefault();
            accept((cur ?? matches[0])!.candidate);
          } else if (e.key === "Enter" && onSubmit) {
            e.preventDefault();
            const v = cur ? cur.candidate.value : value;
            if (cur) accept(cur.candidate);
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
          className="absolute top-full right-0 left-0 z-40 mt-px max-h-64 overflow-y-auto border border-border bg-bg-elev"
        >
          {matches.map((m, i) => (
            <li
              key={`${m.candidate.value}\u0000${m.candidate.label}`}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              // mousedown, not click: keep focus in the input
              onMouseDown={(e) => {
                e.preventDefault();
                accept(m.candidate);
              }}
              onMouseMove={() => setActive(i)}
              className={`flex cursor-default justify-between gap-3 px-2 py-0.5 ${i === active ? "bg-bg-hover text-fg" : "text-fg-muted"}`}
            >
              <span className="truncate text-fg">{highlight(m.candidate.label, m.hits)}</span>
              {m.candidate.detail && <span className="shrink-0 truncate">{highlight(m.candidate.detail, m.detailHits)}</span>}
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
