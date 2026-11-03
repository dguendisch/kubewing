import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeMenu, rowLocators, type Anchor } from "../actions/anchor";
import { menuFor, useMenu } from "../actions/registry";
import { dispatch } from "../commands";
import { useConfig } from "../store/config";
import { useRules } from "../store/rules";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";

/**
 * ⌘⏎ / right-click: every operation on the selected row, generated from
 * actions/registry.ts with shortcuts from the live keymap (and, as a hint,
 * the key of the split variant). Disabled entries say why. ⏎ runs, ⇧⏎ runs
 * in a split, j/k or arrows move, Esc closes.
 */
export function ContextMenu() {
  const overlay = useUI((s) => s.overlay);
  const serverId = useUI((s) => (s.overlay ? s.panes[s.overlay.pane]?.serverId : undefined));
  if (overlay?.kind !== "menu" || !serverId || !overlay.key) return null;
  return <Menu key={overlay.key} paneId={overlay.pane} serverId={serverId} rowKey={overlay.key} />;
}

function Menu({ paneId, serverId, rowKey }: { paneId: string; serverId: string; rowKey: string }) {
  const index = useUI((s) => s.overlay?.index ?? 0);
  const at = useUI((s) => s.overlay?.at);
  const rowIndex = useUI((s) => s.overlay?.rowIndex);
  const el = useRef<HTMLDivElement>(null);
  // Hover only highlights after the pointer really moved in the open menu: a menu
  // appearing under a resting pointer (it's anchored to the row, often right where
  // the mouse is) must keep the keyboard default, the first entry.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hoverArmed = useRef(false);
  const onPointer = (e: React.MouseEvent, i: number, disabled?: string) => {
    if (!hoverArmed.current) {
      const p = pointer.current;
      if (!p) return void (pointer.current = { x: e.clientX, y: e.clientY }); // first sighting: just remember
      if (Math.abs(e.clientX - p.x) < 2 && Math.abs(e.clientY - p.y) < 2) return; // synthetic / no real movement
      hoverArmed.current = true;
    }
    if (!disabled) setUI((s) => (s.overlay?.kind === "menu" && s.overlay.index !== i ? { ...s, overlay: { ...s.overlay, index: i } } : s));
  };
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean }>();
  const context = useUI((s) => s.panes[paneId]?.context);
  const rule = useRules((r) => (context ? r[context] : undefined));
  const bindings = useConfig((s) => s.bindings);
  const { items, row, marked } = useMenu();
  // an object view acts on its object: the table's marks don't apply
  const inObject = useUI((s) => !!s.panes[paneId]?.object);

  useEffect(() => {
    useMenu.setState({ items: [], row: undefined }, true);
    // asked, not taken from the frame: a mark just made may not have reached it yet
    const many = inObject ? Promise.resolve([]) : bridge().marked(serverId).catch(() => []);
    Promise.all([bridge().rowInfo(serverId, rowKey), many]).then(
      ([r, m]) => useMenu.setState({ row: r, marked: m.length ? m : undefined, items: menuFor(r, rule, bindings, m) }, true),
      () => setUI(S.closeOverlay),
    );
  }, [serverId, rowKey]);

  // availability follows rule/keymap changes while open; highlight the first enabled entry
  useEffect(() => {
    if (!row) return;
    const next = menuFor(row, rule, bindings, marked);
    useMenu.setState({ items: next });
    const first = next.findIndex((i) => !i.disabled);
    setUI((s) => (s.overlay?.kind === "menu" && next[s.overlay.index ?? 0]?.disabled && first >= 0 ? { ...s, overlay: { ...s.overlay, index: first } } : s));
  }, [row, rule, bindings]);

  // anchored to the pointer (right-click) or to the row (⌘⏎); measured before paint so it never jumps
  useLayoutEffect(() => {
    const place = () => {
      const m = el.current;
      if (!m) return;
      const loc = rowLocators.get(serverId);
      const box = rowIndex !== undefined ? loc?.row(rowIndex) : undefined;
      const viewport = loc?.viewport();
      const anchor: Anchor | undefined = at
        ? { kind: "point", ...at }
        : box && viewport
          ? { kind: "row", row: box, viewport }
          : viewport
            ? { kind: "row", row: { ...viewport, height: 0 }, viewport } // row not rendered: top of the pane
            : undefined;
      if (!anchor) return setPos(undefined);
      setPos(placeMenu(anchor, { width: m.offsetWidth, height: m.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [serverId, rowIndex, at?.x, at?.y, items.length]);

  return (
    <div
      ref={el}
      role="menu"
      aria-label={`actions for ${row?.name ?? "…"}`}
      data-placement={pos ? (pos.above ? "above" : "below") : undefined}
      className={`absolute z-40 flex w-80 flex-col border border-accent bg-bg-elev py-1 shadow-2xl ${pos ? "" : "top-24 left-1/2 -translate-x-1/2"}`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div className="border-b border-border px-3 pb-1 text-fg-muted">
        {marked ? (
          <>
            <span className="text-marked">{marked.length} marked</span> · cursor on <span className="text-fg">{row?.name}</span>
          </>
        ) : (
          <>
            <span className="text-fg">{row?.name ?? "…"}</span>
            {row ? ` · ${row.kind.toLowerCase()}${row.namespace ? ` · ${row.namespace}` : ""}` : null}
          </>
        )}
      </div>
      {items.map((it, i) => (
        <div key={it.command}>
          {i > 0 && items[i - 1]!.group !== it.group ? <div role="separator" className="my-1 border-t border-border" /> : null}
          <button
            role="menuitem"
            aria-disabled={it.disabled ? true : undefined}
            aria-keyshortcuts={it.shortcut}
            title={it.disabled}
            data-active={i === index || undefined}
            className={`flex w-full items-baseline gap-2 px-3 py-0.5 text-left ${i === index ? "bg-bg-hover" : ""} ${
              it.disabled ? "text-fg-muted" : it.group === "danger" ? "text-deleted" : "text-fg"
            }`}
            onMouseMove={(e) => onPointer(e, i, it.disabled)}
            onClick={() => {
              if (it.disabled) return;
              // the jump menu and the cell picker replace this one at its anchor (they close it themselves)
              if (!S.replacesMenu(it.command)) setUI(S.closeOverlay);
              dispatch(it.command);
            }}
          >
            <span>{it.label}</span>
            {it.multi === false && !it.disabled ? <span className="truncate text-[11px] text-fg-muted">· {row?.name}</span> : null}
            {it.disabled ? <span className="truncate text-[11px]">· {it.disabled}</span> : null}
            <span className="ml-auto text-fg-muted">{it.shortcut}</span>
            {it.splitShortcut ? (
              <span className="text-[11px] text-fg-muted" title={`${it.splitShortcut}: in a split to the right`}>
                · {it.splitShortcut} split
              </span>
            ) : null}
          </button>
        </div>
      ))}
    </div>
  );
}
