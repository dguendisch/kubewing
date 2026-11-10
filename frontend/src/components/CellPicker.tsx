import { useLayoutEffect, useRef, useState } from "react";
import { placeMenu, rowLocators, type Anchor } from "../actions/anchor";
import { copyCell } from "../commands";
import { setUI, useUI } from "../store/store";

/**
 * ⌘⇧C, or "copy cell…" in the ⌘⏎ menu: the selected row's cells, each with
 * its column and value, then the whole row (tab-separated). j/k or arrows
 * move, ⏎ (or a click) copies, Esc cancels. Highlighted first: the cell
 * right-clicked, else the column copied last. Anchored like the ⌘⏎ menu.
 */
export function CellPicker() {
  const o = useUI((s) => (s.overlay?.kind === "cells" ? s.overlay : undefined));
  const serverId = useUI((s) => (s.overlay?.kind === "cells" ? s.panes[s.overlay.pane]?.serverId : undefined));
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>();
  const at = o?.at;
  const rowIndex = o?.rowIndex;

  useLayoutEffect(() => {
    const m = el.current;
    if (!m || !serverId) return;
    const loc = rowLocators.get(serverId);
    const box = rowIndex !== undefined ? loc?.row(rowIndex) : undefined;
    const viewport = loc?.viewport();
    const anchor: Anchor | undefined = at
      ? { kind: "point", ...at }
      : box && viewport
        ? { kind: "row", row: box, viewport }
        : viewport
          ? { kind: "row", row: { ...viewport, height: 0 }, viewport }
          : undefined;
    setPos(anchor && placeMenu(anchor, { width: m.offsetWidth, height: m.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [serverId, rowIndex, at?.x, at?.y, o?.cells?.length]);

  if (!o?.cells) return null;
  const index = o.index ?? 0;
  return (
    <div
      ref={el}
      role="menu"
      aria-label="copy cell"
      className={`absolute z-40 flex max-w-[36rem] min-w-80 flex-col border border-accent bg-bg-elev py-1 shadow-menu ${pos ? "" : "top-24 left-1/2 -translate-x-1/2"}`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div className="border-b border-border px-3 pb-1 text-fg-muted">copy cell</div>
      {o.cells.map((c, i) => (
        <button
          key={c.label}
          role="menuitem"
          aria-disabled={c.disabled ? true : undefined}
          title={c.disabled ?? c.text}
          data-active={i === index || undefined}
          className={`flex w-full items-baseline gap-3 px-3 py-0.5 text-left ${i === index ? "bg-bg-hover" : ""} ${c.disabled ? "text-fg-muted" : "text-fg"}`}
          onMouseMove={() => {
            if (!c.disabled) setUI((s) => (s.overlay?.kind === "cells" && s.overlay.index !== i ? { ...s, overlay: { ...s.overlay, index: i } } : s));
          }}
          onClick={() => void copyCell(i)}
        >
          <span className="shrink-0 text-small text-fg-muted">{c.label}</span>
          <span className="ml-auto truncate">{c.disabled ? <span className="text-fg-muted">{c.disabled}</span> : (c.shown ?? c.text)}</span>
        </button>
      ))}
      <div className="border-t border-border px-3 pt-1 text-fg-muted">⏎ copy · esc cancel</div>
    </div>
  );
}
