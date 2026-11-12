import { create } from "zustand";
import { setUI, useUI } from "../store/store";
import * as S from "../store/state";
import type { Rect } from "../store/layout";
import { canDetachTab, detachTab, sendTab, TAB_BAR } from "../store/transfer";
import { otherWindows, useWindows } from "../store/window";
import { tabTitle } from "./tabTitle";
import { windowDrag, type WindowDrag } from "./windowDrag";

/**
 * Reordering tabs by dragging them in the tab bar (Safari, iTerm): past a
 * few pixels a press on a tab becomes a drag, and the tab moves among the
 * others as the pointer crosses their middles, so the bar always shows the
 * order a release keeps; it's the tab shown. Esc puts the order back. A press that doesn't move
 * stays a click (and a double-click names the tab).
 *
 * Other windows take tabs too (Chrome): dragged over another window, that
 * window shows where the tab would go in its tab bar, and a release moves
 * it there with all its panes (store/transfer.ts). Released outside every
 * window, the tab gets a window of its own there.
 */
export const useTabDrag = create<{ tab?: string; away?: boolean; outside?: boolean }>(() => ({}));

/** Pixels the pointer moves before a press on a tab becomes a drag (as for a pane's grip). */
const THRESHOLD = 4;

type Box = { left: number; right: number; top: number; bottom: number };

/**
 * Where the dragged tab belongs for a pointer at (x, y), given the other tabs' boxes in order:
 * in the row the pointer is in (the nearest one, above or below the bar), before the first tab
 * whose middle lies right of it, else after that row's last tab.
 */
export function dropIndex(boxes: Box[], x: number, y: number): number {
  if (!boxes.length) return 0;
  const dist = (b: Box) => (y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0);
  const d = Math.min(...boxes.map(dist));
  const row = boxes.map((b, i) => ({ b, i })).filter(({ b }) => dist(b) === d);
  const hit = row.find(({ b }) => x < (b.left + b.right) / 2);
  return hit ? hit.i : row[row.length - 1]!.i + 1;
}

/** Where a tab from another window lands in this one's tab bar. */
export interface TabTarget {
  at: number;
}

/**
 * A tab from another window over this one at (x, y): over the tab bar, the
 * place among the tabs the pointer is at; anywhere else, after the last one.
 * rect: a marker in the bar where it would go.
 */
export function tabTargetAt(x: number, y: number): { target: TabTarget; rect?: Rect } {
  const boxes = [...document.querySelectorAll<HTMLElement>("[role=tablist] [data-tab]")].map((el) => el.getBoundingClientRect());
  const bar = document.querySelector("[role=tablist]")?.getBoundingClientRect();
  const inBar = !!bar && x >= bar.left && x < bar.right && y >= bar.top && y < bar.bottom;
  const at = inBar ? dropIndex(boxes, x, y) : boxes.length;
  const b = boxes[at] ?? boxes[boxes.length - 1];
  if (!b) return { target: { at } };
  return { target: { at }, rect: { x: (boxes[at] ? b.left : b.right) - 2, y: b.top, w: 4, h: b.height } };
}

/** Starts following a press on a tab; window listeners take over until it's released. */
export function startTabDrag(tabId: string, down: PointerEvent) {
  const before = useUI.getState().tabs.map((t) => t.id);
  let dragging = false;
  const cursor = document.body.style.cursor;
  // out of every window: a window of its own, unless it's already one, or it's the only tab there is
  const detachable = () => {
    const s = useUI.getState();
    return canDetachTab(s, tabId) && (s.tabs.length > 1 || otherWindows(useWindows.getState().names).length > 0);
  };
  let outside: { sx: number; sy: number } | undefined;

  const reorder = (e: PointerEvent) => {
    // the other tabs, as laid out now (they shift, and change rows, while the dragged one passes)
    const boxes = [...document.querySelectorAll<HTMLElement>("[role=tablist] [data-tab]")].filter((el) => el.dataset.tab !== tabId).map((el) => el.getBoundingClientRect());
    const to = dropIndex(boxes, e.clientX, e.clientY);
    setUI((s) => S.moveTab(s, tabId, to));
  };
  const s0 = useUI.getState();
  const t0 = s0.tabs.find((t) => t.id === tabId);
  const p0 = t0 && s0.panes[t0.focused];
  // across windows: only once the press is a drag (a click asks nothing)
  let across: WindowDrag<TabTarget> | undefined;
  const follow = () =>
    windowDrag<TabTarget>("tab", tabTitle(t0, p0), (e, w) => {
      outside = w.in === "outside" && detachable() ? { sx: w.sx, sy: w.sy } : undefined;
      useTabDrag.setState({ tab: tabId, away: w.in === "other" || undefined, outside: !!outside || undefined });
      if (w.in === "here") reorder(e);
    });

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(e.clientX - down.clientX) < THRESHOLD && Math.abs(e.clientY - down.clientY) < THRESHOLD) return;
      dragging = true;
      document.body.style.cursor = "grabbing";
      useTabDrag.setState({ tab: tabId });
      across = follow();
      // the tab dragged is the one shown, as in Chrome (the release makes no click: the tab moved in the DOM)
      setUI((s) => {
        const i = s.tabs.findIndex((t) => t.id === tabId);
        return i >= 0 && i !== s.activeTab ? { ...s, activeTab: i, overlay: undefined, focus: "table" } : s;
      });
    }
    across!.move(e);
  };
  // where on the tab it was grabbed: a new window opens with its tab bar under the pointer, about where it was grabbed
  const grab = (() => {
    const r = document.querySelector(`[role=tablist] [data-tab="${CSS.escape(tabId)}"]`)?.getBoundingClientRect();
    return r ? { x: Math.min(down.clientX - r.left + 80, 200), y: Math.min(down.clientY - r.top, TAB_BAR) } : { x: 80, y: TAB_BAR / 2 };
  })();
  const end = async (keep: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    if (!dragging || !across) return;
    document.body.style.cursor = cursor;
    const { away } = useTabDrag.getState();
    useTabDrag.setState({ tab: undefined, away: undefined, outside: undefined });
    const back = () => setUI((s) => before.reduce((x, id, i) => S.moveTab(x, id, i), s));
    if (!keep) {
      across.cancel();
      return back();
    }
    if (outside) {
      across.cancel();
      back();
      return detachTab(tabId, { x: outside.sx - grab.x, y: outside.sy - grab.y });
    }
    if (away) {
      // the window under the pointer says where the tab goes (its last answer may still be on the way)
      const d = await across.drop();
      back();
      if (d?.target) await sendTab(tabId, d.window, d.target.at);
      return;
    }
    across.cancel();
  };
  const up = () => void end(true);
  const cancel = () => void end(false);
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    void end(false);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}

/** While a tab is dragged out of the window: its panes are dimmed and say where they go. */
export function TabLeaving() {
  const drag = useTabDrag();
  const leaving = drag.tab && (drag.away || drag.outside) ? document.querySelector(`[data-tab-area="${CSS.escape(drag.tab)}"]`) : null;
  if (!leaving) return null;
  const r = leaving.getBoundingClientRect();
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      <div
        aria-label="leaving tab"
        className="absolute flex items-center justify-center bg-bg/70 backdrop-grayscale"
        style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
      >
        <span className="rounded border border-accent bg-bg-elev px-3 py-1 text-fg shadow-menu">{drag.away ? "↗ the tab moves to the other window" : "↗ the tab opens in a new window"}</span>
      </div>
    </div>
  );
}
