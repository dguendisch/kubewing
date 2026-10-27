import { create } from "zustand";
import { setUI, useUI } from "../store/store";
import * as S from "../store/state";

/**
 * Reordering tabs by dragging them in the tab bar (Safari, iTerm): past a
 * few pixels a press on a tab becomes a drag, and the tab moves among the
 * others as the pointer crosses their middles, so the bar always shows the
 * order a release keeps; it's the tab shown. Esc puts the order back. A press that doesn't move
 * stays a click (and a double-click names the tab).
 */
export const useTabDrag = create<{ tab?: string }>(() => ({}));

/** Pixels the pointer moves before a press on a tab becomes a drag (as for a pane's grip). */
const THRESHOLD = 4;

/** Where the dragged tab belongs for a pointer at x: before the first other tab whose middle lies right of it. */
export function dropIndex(mids: number[], x: number): number {
  const i = mids.findIndex((m) => x < m);
  return i < 0 ? mids.length : i;
}

/** Starts following a press on a tab; window listeners take over until it's released. */
export function startTabDrag(tabId: string, down: PointerEvent) {
  const before = useUI.getState().tabs.map((t) => t.id);
  let dragging = false;
  const cursor = document.body.style.cursor;

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(e.clientX - down.clientX) < THRESHOLD && Math.abs(e.clientY - down.clientY) < THRESHOLD) return;
      dragging = true;
      document.body.style.cursor = "grabbing";
      useTabDrag.setState({ tab: tabId });
      // the tab dragged is the one shown, as in Chrome (the release makes no click: the tab moved in the DOM)
      setUI((s) => {
        const i = s.tabs.findIndex((t) => t.id === tabId);
        return i >= 0 && i !== s.activeTab ? { ...s, activeTab: i, overlay: undefined, focus: "table" } : s;
      });
    }
    // the other tabs' middles, as laid out now (they shift while the dragged one passes)
    const mids = [...document.querySelectorAll<HTMLElement>("[role=tablist] [data-tab]")]
      .filter((el) => el.dataset.tab !== tabId)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      });
    const to = dropIndex(mids, e.clientX);
    setUI((s) => S.moveTab(s, tabId, to));
  };
  const end = (keep: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    if (!dragging) return;
    document.body.style.cursor = cursor;
    useTabDrag.setState({ tab: undefined });
    if (!keep) setUI((s) => before.reduce((x, id, i) => S.moveTab(x, id, i), s));
  };
  const up = () => end(true);
  const cancel = () => end(false);
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    end(false);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
