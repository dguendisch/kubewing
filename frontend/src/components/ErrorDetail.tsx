import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";

/**
 * An error in the status line: its first line, clickable. The rest (what the
 * server actually answered, see source.errText) is in the popover above it.
 */
export function StatusError({ paneId, which, text, prefix = "" }: { paneId: string; which: "source" | "filter" | "skipped"; text: string; prefix?: string }) {
  const first = text.split("\n", 1)[0];
  const open = useUI((s) => s.overlay?.kind === "error" && s.overlay.pane === paneId && s.overlay.view === which);
  return (
    <button
      type="button"
      aria-label={which === "source" ? "pane error" : which === "filter" ? "filter errors" : "skipped types"}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-error-anchor={`${paneId}:${which}`}
      title="click for the full message"
      className="min-w-0 cursor-pointer truncate text-left text-deleted underline decoration-dotted underline-offset-2"
      // the table keeps the keyboard focus until the popover takes it
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        if (open) return setUI(S.closeOverlay);
        const b = e.currentTarget.getBoundingClientRect();
        setUI((s) => S.openOverlay(S.closeOverlay(S.focusPane(s, paneId)), { kind: "error", pane: paneId, view: which, text, at: { x: b.left, y: b.top } }));
      }}
    >
      {prefix}
      {first}
    </button>
  );
}

/**
 * The full error, above its status line entry: selectable (⌘C copies the
 * selection, as in a text field), "copy" takes all of it. Esc, a click
 * elsewhere or on the entry again closes it.
 */
export function ErrorDetail() {
  const o = useUI((s) => s.overlay);
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number }>();
  const [copied, setCopied] = useState(false);
  const open = o?.kind === "error";

  useLayoutEffect(() => {
    const m = el.current;
    if (!m || !open || !o.at) return setPos(undefined);
    // above the entry (the status line is at the bottom), kept inside the window
    setPos({ left: Math.max(4, Math.min(o.at.x, window.innerWidth - m.offsetWidth - 4)), bottom: window.innerHeight - o.at.y + 2 });
  }, [open, o?.at?.x, o?.at?.y, o?.text]);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    el.current?.focus();
    const away = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && (el.current?.contains(t) || t.closest("[data-error-anchor]"))) return;
      setUI((s) => (s.overlay?.kind === "error" ? S.closeOverlay(s) : s));
    };
    window.addEventListener("mousedown", away, { capture: true });
    return () => window.removeEventListener("mousedown", away, { capture: true });
  }, [open, o?.text]);

  if (!open || !o.text) return null;
  const text = o.text;
  return (
    <div
      ref={el}
      role="dialog"
      aria-label="error detail"
      tabIndex={-1}
      className="absolute z-40 flex max-h-[60vh] w-[36rem] max-w-[calc(100vw-8px)] flex-col border border-deleted bg-bg-elev shadow-2xl outline-none"
      style={pos ? { left: pos.left, bottom: pos.bottom } : { visibility: "hidden" }}
      onMouseDown={(e) => e.stopPropagation()} // a press here is a selection, not a pane focus
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <div className="flex items-center border-b border-border px-2 py-0.5 text-fg-muted">
        <span>{o.view === "filter" ? "filter error" : o.view === "skipped" ? "not listed" : "error"} · select and ⌘C, or</span>
        <button
          type="button"
          className="ml-1 text-accent hover:underline"
          onClick={() =>
            void bridge()
              .copyText(text)
              .then(() => setCopied(true), () => {})
          }
        >
          {copied ? "copied" : "copy all"}
        </button>
        <span className="ml-auto">esc</span>
      </div>
      <pre aria-label="error text" className="overflow-auto px-2 py-1 whitespace-pre-wrap break-words text-fg select-text">
        {text}
      </pre>
    </div>
  );
}
