import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeMenu } from "../actions/anchor";
import { moveHistory, openHistoryList, pickHistory } from "../commands";
import { useConfig } from "../store/config";
import { prettyKey } from "../keys/keymap";
import { setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { describeView } from "./history";

/** How long a press on ← / → takes to open the history list instead of going one step. */
const holdMs = 400;

type Dir = "back" | "forward";

/**
 * Top left of a table pane, as in a browser: ← back and → forward, greyed
 * out when there's nowhere to go. A click goes one step; holding the button
 * (or a right-click) lists that history, the nearest view first.
 */
export function HistoryButtons({ pane }: { pane: S.PaneState }) {
  return (
    <span className="flex shrink-0 items-center">
      <HistoryButton pane={pane} dir="back" />
      <HistoryButton pane={pane} dir="forward" />
    </span>
  );
}

function HistoryButton({ pane, dir }: { pane: S.PaneState; dir: Dir }) {
  const list = dir === "back" ? pane.back : pane.forward;
  const next = list?.at(-1);
  // the live key (keybindings.yaml may rebind or unbind it)
  const key = useConfig((c) => c.bindings.find((b) => b.command === `history.${dir}`)?.key);
  const open = useUI((s) => s.overlay?.kind === "history" && s.overlay.pane === pane.id && s.overlay.dir === dir);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // the press opened the list (or closed it): the click that ends it goes nowhere
  const swallow = useRef(false);
  const el = useRef<HTMLButtonElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const showList = () => {
    const b = el.current?.getBoundingClientRect();
    if (b) openHistoryList(pane.id, dir, { x: b.left, y: b.bottom });
  };
  const title = next
    ? `${dir} to ${describeView(next.spec, pane.spec.context).label}${key ? ` (${prettyKey(key)})` : ""} · hold for the list (${list!.length})`
    : dir === "back" ? "nothing to go back to" : "nothing to go forward to";
  return (
    <button
      ref={el}
      type="button"
      aria-label={dir}
      aria-haspopup="menu"
      aria-expanded={open}
      data-history={`${pane.id}:${dir}`}
      title={title}
      disabled={!next}
      className={`px-1 text-base leading-none ${open ? "bg-bg-hover text-fg" : ""} ${next ? "text-fg hover:bg-bg-hover" : "text-fg-muted opacity-40"}`}
      onMouseDown={(e) => {
        // keep the keyboard focus where it is (table or field); the pane still gets focused (section)
        e.preventDefault();
        if (e.button !== 0) return;
        swallow.current = false;
        if (open) {
          swallow.current = true; // a press on the open list's button closes it, as a browser does
          return setUI(S.closeOverlay);
        }
        timer.current = setTimeout(() => {
          swallow.current = true;
          showList();
        }, holdMs);
      }}
      onMouseUp={() => clearTimeout(timer.current)}
      onMouseLeave={() => clearTimeout(timer.current)}
      onClick={() => {
        if (swallow.current) return void (swallow.current = false);
        void moveHistory(dir, pane.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        clearTimeout(timer.current);
        if (!open) showList();
      }}
    >
      {dir === "back" ? "←" : "→"}
    </button>
  );
}

/**
 * The list a held ← / → opens, below the button: that history's views, the
 * nearest first (index i is i+1 steps). j/k or arrows move, ⏎ or a click
 * goes there, Esc or a click elsewhere closes.
 */
export function HistoryList() {
  const o = useUI((s) => s.overlay);
  const pane = useUI((s) => (s.overlay?.kind === "history" ? s.panes[s.overlay.pane] : undefined));
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>();
  const entries = o?.kind === "history" ? [...((o.dir === "back" ? pane?.back : pane?.forward) ?? [])].reverse() : [];

  useLayoutEffect(() => {
    const m = el.current;
    if (!m || o?.kind !== "history" || !o.at) return setPos(undefined);
    setPos(placeMenu({ kind: "point", ...o.at }, { width: m.offsetWidth, height: m.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [o?.kind, o?.at?.x, o?.at?.y, entries.length]);

  // a dropdown: a press anywhere else closes it (its own button toggles it itself)
  const open = o?.kind === "history";
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && (el.current?.contains(t) || t.closest("[data-history]"))) return;
      setUI((s) => (s.overlay?.kind === "history" ? S.closeOverlay(s) : s));
    };
    window.addEventListener("mousedown", away, { capture: true });
    return () => window.removeEventListener("mousedown", away, { capture: true });
  }, [open]);

  if (o?.kind !== "history" || !pane || entries.length === 0) return null;
  const index = o.index ?? 0;
  return (
    <div
      ref={el}
      role="menu"
      aria-label={`${o.dir} history`}
      className="absolute z-40 flex max-h-[70vh] w-96 flex-col overflow-y-auto border border-accent bg-bg-elev py-1 shadow-2xl"
      style={pos ? { left: pos.x, top: pos.y } : { visibility: "hidden" }}
      // the pane under it must not take the press (it would refocus and close this)
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {entries.map((h, i) => {
        const { label, detail } = describeView(h.spec, pane.spec.context);
        return (
          <button
            key={i}
            role="menuitem"
            data-active={i === index || undefined}
            className={`flex w-full items-baseline gap-2 px-3 py-0.5 text-left text-fg ${i === index ? "bg-bg-hover" : ""}`}
            onMouseMove={() => setUI((s) => (s.overlay?.kind === "history" && s.overlay.index !== i ? { ...s, overlay: { ...s.overlay, index: i } } : s))}
            onClick={() => void pickHistory(i)}
          >
            <span className="shrink-0">{label}</span>
            {detail ? <span className="truncate text-[11px] text-fg-muted">{detail}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
