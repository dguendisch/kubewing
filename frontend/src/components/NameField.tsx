import { useEffect, useRef, useState } from "react";
import { setUI, useUI } from "../store/store";
import * as S from "../store/state";

/**
 * The name field of a tab or pane, in place of its title (renameTab /
 * renamePane overlay). The name applies as it's typed, so it's kept however
 * the field goes (⏎, a click elsewhere, a key that moves the focus, another
 * overlay); Esc puts the old one back. An empty name removes it. Without a
 * name, the field starts with `shown` (the title in its place), selected: it
 * becomes the name only once edited, so ⏎ leaves it unnamed.
 */
export function NameField({ label, initial, shown = "", onName, className = "" }: { label: string; initial: string; shown?: string; onName: (name: string) => (s: S.UIState) => S.UIState; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial || shown);
  // as opened: the name applies as typed, so `initial` follows it
  const [before] = useState(initial);
  useEffect(() => ref.current?.select(), []);
  // closes only its own overlay: a click elsewhere may have opened another one meanwhile
  const close = () => setUI((s) => (s.overlay?.kind === "renameTab" || s.overlay?.kind === "renamePane" ? S.closeOverlay(s) : s));
  // a global key took the focus elsewhere (⌘D, ⌘[ …)
  const away = useUI((s) => s.focus !== "dialog");
  useEffect(() => {
    if (away) close();
  }, [away]);
  return (
    <input
      ref={ref}
      autoFocus
      aria-label={label}
      placeholder="name"
      value={value}
      size={Math.max(8, value.length + 1)}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        setUI(onName(e.target.value));
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(onName(before));
        else if (e.key !== "Enter") return;
        e.preventDefault();
        close();
      }}
      onBlur={close}
      // the tab and the pane under it take clicks and drags as their own otherwise
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`min-w-0 rounded border border-accent bg-bg px-1 text-fg outline-none ${className}`}
    />
  );
}

/** A pane's name in its header: a label (a double-click renames), or the field while it's being named. */
export function PaneName({ pane }: { pane: S.PaneState }) {
  const editing = useUI((s) => s.overlay?.kind === "renamePane" && s.overlay.pane === pane.id);
  if (editing) return <NameField label="pane name" initial={pane.name ?? ""} onName={(name) => (s) => S.namePane(s, pane.id, name)} />;
  if (!pane.name) return null;
  return (
    <span
      aria-label="pane name"
      title="double-click to rename (⌘I)"
      className="shrink-0 truncate rounded bg-bg-hover px-1.5 font-semibold text-fg"
      onDoubleClick={() => setUI((s) => S.renamePane(s, pane.id))}
    >
      {pane.name}
    </span>
  );
}
