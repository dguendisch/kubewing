import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { edgeShare, nearestSide, paneIds, sidePart, type Rect, type Side } from "../store/layout";
import { setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { tabTitle } from "./tabTitle";

/**
 * Moving a pane by drag and drop (ghostty): a grip shows at the top of a pane
 * while the mouse moves over it; dragging it shows where the pane would go,
 * and dropping moves it there (S.movePane). Targets: a side of another pane
 * (the nearest one), an edge of the tab (close to it), a tab header (that
 * tab's right edge; holding over it shows the tab, so a pane there can be
 * picked), or + (a new tab). Esc cancels, back on the tab the drag started in.
 */
interface Drag {
  pane: string;
  x: number;
  y: number;
  target?: S.MoveTarget;
  /** The preview of the target, in viewport pixels. */
  rect?: Rect;
}

const useDrag = create<{ drag?: Drag }>(() => ({}));

/** Pixels the pointer moves before a press on the grip becomes a drag. */
const THRESHOLD = 4;
/** Within this many pixels of the tab's border, a drop goes to the tab's edge. */
const EDGE = 16;
/** How long the grip stays after the mouse stops moving. */
const LINGER = 1200;
/** Holding a drag over a tab header this long shows that tab. */
const DWELL = 450;

const box = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** What lies under the pointer, if the pane can move there. */
function targetAt(s: S.UIState, pane: string, x: number, y: number): Pick<Drag, "target" | "rect"> {
  const hit = (t: S.MoveTarget, rect: Rect) => (S.movePane(s, pane, t) !== s ? { target: t, rect } : {});
  let over: HTMLElement | undefined; // the pane under the pointer (topmost first)
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.dataset.newTab !== undefined) return hit({ newTab: true }, box(el));
    if (el.dataset.tab) return hit({ tab: el.dataset.tab, side: "right" }, box(el));
    if (el.dataset.pane) over ??= el;
    const area = el.dataset.tabArea;
    const t = area ? s.tabs.find((x) => x.id === area) : undefined;
    if (!t) continue;
    const r = box(el);
    const near: [Side, number][] = [
      ["left", x - r.x],
      ["right", r.x + r.w - x],
      ["top", y - r.y],
      ["bottom", r.y + r.h - y],
    ];
    const [edge, d] = near.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (d <= EDGE) return hit({ tab: t.id, side: edge }, sidePart(r, edge, edgeShare(t.layout, edge)));
    const id = over?.dataset.pane;
    if (!over || !id || !paneIds(t.layout).includes(id)) return {};
    const pr = box(over);
    const side = nearestSide(pr, x, y);
    return hit({ tab: t.id, pane: id, side }, sidePart(pr, side, 0.5));
  }
  return {};
}

/** Starts a drag from a press on a pane's grip; window listeners follow the pointer until it's released. */
function startDrag(pane: string, down: PointerEvent) {
  const startTab = S.activeTab(useUI.getState()).id;
  let dragging = false;
  let dwell: { tab: string; timer: number } | undefined;
  const cursor = document.body.style.cursor;

  const hold = (x: number, y: number) => {
    const el = document.elementsFromPoint(x, y).find((e): e is HTMLElement => e instanceof HTMLElement && !!e.dataset.tab);
    const tab = el?.dataset.tab;
    if (dwell?.tab === tab) return;
    if (dwell) clearTimeout(dwell.timer);
    dwell = tab
      ? {
          tab,
          timer: window.setTimeout(() => {
            setUI((s) => {
              const i = s.tabs.findIndex((t) => t.id === tab);
              return i >= 0 && i !== s.activeTab ? { ...s, activeTab: i } : s;
            });
            // the tab's panes are laid out now: what's under the pointer changed
            const d = useDrag.getState().drag;
            if (d) useDrag.setState({ drag: { ...d, ...targetAt(useUI.getState(), pane, d.x, d.y) } });
          }, DWELL),
        }
      : undefined;
  };

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < THRESHOLD) return;
      dragging = true;
      document.body.style.cursor = "grabbing";
    }
    hold(e.clientX, e.clientY);
    useDrag.setState({ drag: { pane, x: e.clientX, y: e.clientY, ...targetAt(useUI.getState(), pane, e.clientX, e.clientY) } });
  };
  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    if (dwell) clearTimeout(dwell.timer);
    document.body.style.cursor = cursor;
    const target = useDrag.getState().drag?.target;
    useDrag.setState({ drag: undefined });
    if (drop && target) setUI((s) => S.movePane(s, pane, target));
    else if (dragging) {
      setUI((s) => {
        const i = s.tabs.findIndex((t) => t.id === startTab);
        return i >= 0 && i !== s.activeTab ? { ...s, activeTab: i } : s;
      });
    }
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

/**
 * A pane's grip, top center: shown while the mouse moves over the pane (and
 * a little after), or while it's on the grip itself; never when there is
 * nowhere to move the pane to (the only pane of the only tab).
 */
export function Grip({ id }: { id: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(false);
  const movable = useUI((s) => s.tabs.length > 1 || s.tabs.some((t) => paneIds(t.layout).length > 1));
  const dragged = useDrag((d) => d.drag?.pane === id);
  // during a drag only the dragged pane's grip shows: the others would be noise over the targets
  const anyDrag = useDrag((d) => !!d.drag);
  const visible = dragged || (shown && !anyDrag);

  useEffect(() => {
    const pane = ref.current?.parentElement;
    if (!pane) return;
    let timer: number | undefined;
    const onMove = () => {
      setShown(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!ref.current?.matches(":hover")) setShown(false);
      }, LINGER);
    };
    const onLeave = () => {
      clearTimeout(timer);
      setShown(false);
    };
    pane.addEventListener("mousemove", onMove);
    pane.addEventListener("mouseleave", onLeave);
    return () => {
      clearTimeout(timer);
      pane.removeEventListener("mousemove", onMove);
      pane.removeEventListener("mouseleave", onLeave);
    };
  }, [movable]);

  if (!movable) return null;
  return (
    <button
      ref={ref}
      type="button"
      aria-label="move pane"
      title="drag to move the pane: next to another one, to a tab's edge, onto a tab or + (a new tab)"
      data-shown={visible || undefined}
      tabIndex={-1}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // no focus change or text selection: a press alone does nothing
        e.preventDefault();
        e.stopPropagation();
        startDrag(id, e.nativeEvent);
      }}
      className={`absolute top-0 left-1/2 z-20 flex h-3 w-12 -translate-x-1/2 cursor-grab items-center justify-center rounded-b bg-bg-hover transition-opacity duration-150 ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`}
    >
      <span aria-hidden className="h-0.5 w-6 rounded-full bg-fg-muted" />
    </button>
  );
}

/** While dragging: where the pane would go, and what's being moved next to the pointer. */
export function DragPreview() {
  const drag = useDrag((d) => d.drag);
  const pane = useUI((s) => (drag ? s.panes[drag.pane] : undefined));
  if (!drag) return null;
  const r = drag.rect;
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {r ? (
        <div
          aria-label="drop target"
          className="absolute border-2 border-accent bg-accent/25"
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        />
      ) : null}
      <div
        aria-label="moving pane"
        className="absolute border border-accent bg-bg-elev px-2 py-0.5 text-fg shadow-lg"
        style={{ left: drag.x + 12, top: drag.y + 12 }}
      >
        {pane?.term ? `${pane.term.pod}/${pane.term.container}` : tabTitle(pane)}
      </div>
    </div>
  );
}
