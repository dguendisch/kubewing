import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { edgeShare, nearestSide, paneIds, sidePart, type Rect, type Side } from "../store/layout";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { canDetach, detachPane, onDragMessage, sendPane, TAB_BAR } from "../store/transfer";

/** The running drag's handler of answers from the window it's over (dragtarget). */
let answer: ((m: WindowMessage) => void) | undefined;
import { otherWindows, useWindows, windowName } from "../store/window";
import type { PointerInfo, WindowInfo, WindowMessage } from "../transport/types";
import { paneTitle } from "./tabTitle";

/**
 * Moving a pane by drag and drop (ghostty): a grip shows at the top of a pane
 * while the mouse moves over it; dragging it shows where the pane would go,
 * and dropping moves it there (S.movePane). Targets: a side of another pane
 * (the nearest one), an edge of the tab (close to it), a tab header (that
 * tab's right edge; holding over it shows the tab, so a pane there can be
 * picked), or + (a new tab). Esc cancels, back on the tab the drag started in.
 *
 * Other windows are targets too, the same ones: dragged over another window,
 * that window shows where the pane would go in it (it's told the pointer's
 * screen position and answers with its target), and a drop hands the pane
 * over to it (store/transfer.ts). Dropped outside every window, the pane
 * gets a window of its own there.
 */
interface Drag {
  pane: string;
  x: number;
  y: number;
  target?: S.MoveTarget;
  /** The preview of the target, in viewport pixels. */
  rect?: Rect;
  /** The pointer is over another window (its name): that window shows the target. */
  away?: string;
  /** The pointer is outside every window: a drop detaches the pane into a new one there. */
  outside?: boolean;
  /** The pointer on screen (where a detached pane's window opens). */
  sx?: number;
  sy?: number;
}

const useDrag = create<{ drag?: Drag }>(() => ({}));

/** Another window's drag passing over this one: where its pane would land here. */
interface Visit {
  from: string;
  title: string;
  x: number;
  y: number;
  target?: S.MoveTarget;
  rect?: Rect;
}

const useVisit = create<{ visit?: Visit }>(() => ({}));

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

/**
 * What lies under the pointer, if the pane can move there. pane undefined:
 * a pane from another window (anywhere valid will do; it isn't in a tab here).
 */
function targetAt(s: S.UIState, pane: string | undefined, x: number, y: number): Pick<Drag, "target" | "rect"> {
  const ok = (t: S.MoveTarget) => (pane ? S.movePane(s, pane, t) !== s : S.canInsert(s, t));
  const hit = (t: S.MoveTarget, rect: Rect) => (ok(t) ? { target: t, rect } : {});
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

/** Holding over a tab header for DWELL shows that tab (then what's under the pointer is laid out anew). */
function dweller(onShown: () => void) {
  let dwell: { tab: string; timer: number } | undefined;
  return {
    at(x: number, y: number) {
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
              onShown();
            }, DWELL),
          }
        : undefined;
    },
    stop() {
      if (dwell) clearTimeout(dwell.timer);
      dwell = undefined;
    },
  };
}

/** Where the pointer is during a drag: in this window, in another one (at a point of its page), or outside every one. */
type Where = { in: "here" } | { in: "other"; window: string; x: number; y: number } | { in: "outside"; sx: number; sy: number };

/**
 * The page's own idea of where it is on screen, for the browser build
 * (tests, dev), where there are no native windows to ask: WKWebView's
 * screenX/Y don't match the windows' frames, so the app asks Go (pointer()).
 */
function whereByPage(wins: WindowInfo[], e: PointerEvent): Where {
  const { screenX: sx, screenY: sy } = e;
  if (sx >= window.screenX && sx < window.screenX + window.outerWidth && sy >= window.screenY && sy < window.screenY + window.outerHeight) return { in: "here" };
  const w = wins.find((w) => w.name !== windowName && w.bounds.w > 0 && sx >= w.bounds.x && sx < w.bounds.x + w.bounds.w && sy >= w.bounds.y && sy < w.bounds.y + w.bounds.h);
  return w ? { in: "other", window: w.name, x: sx - w.bounds.x, y: sy - w.bounds.y } : { in: "outside", sx, sy };
}

const whereByOS = (p: PointerInfo): Where =>
  p.window === windowName ? { in: "here" } : p.window ? { in: "other", window: p.window, x: p.inX ?? 0, y: p.inY ?? 0 } : { in: "outside", sx: p.x, sy: p.y };

/** How long a drop over another window waits for that window to say where the pane goes. */
const DROP_WAIT = 1000;

/** Starts a drag from a press on a pane's grip; window listeners follow the pointer until it's released. */
function startDrag(pane: string, down: PointerEvent) {
  const startTab = S.activeTab(useUI.getState()).id;
  let dragging = false;
  const cursor = document.body.style.cursor;
  const title = paneLabel(useUI.getState().panes[pane]);
  // the app asks the OS where the mouse is and which window is in front there; the browser build (no native
  // windows) falls back to the page's screen coordinates and the windows' frames, asked once
  let native = true;
  let wins: WindowInfo[] = [];
  let ended = false;
  // for the browser build: the windows' frames, if it turns out to be one
  if (otherWindows(useWindows.getState().names).length) void bridge().windows().then((w) => (wins = w), () => {});
  let asking = false;
  let last: PointerEvent | undefined;
  // the window the pointer is over, and the target it last reported
  let away: string | undefined;
  let remote: S.MoveTarget | undefined;
  let dropAnswer: ((t: S.MoveTarget | undefined) => void) | undefined;
  const leave = () => {
    if (away) void bridge().sendWindow(away, "dragleave", {}).catch(() => {});
    away = undefined;
    remote = undefined;
  };
  answer = (m) => {
    if (m.from !== away) return;
    const d = m.data as { target?: S.MoveTarget; drop?: boolean };
    remote = d.target;
    if (d.drop) dropAnswer?.(d.target);
  };

  const local = dweller(() => {
    // the tab's panes are laid out now: what's under the pointer changed
    const d = useDrag.getState().drag;
    if (d && !d.away && !d.outside) useDrag.setState({ drag: { ...d, ...targetAt(useUI.getState(), pane, d.x, d.y) } });
  });

  /** Follows the pointer to where it is: a target here, another window's (it shows it), or out of every window. */
  const at = (e: PointerEvent, w: Where) => {
    if (ended) return; // a late answer, after the drop
    if (w.in === "outside") {
      // a window of its own, if it isn't one already
      leave();
      local.stop();
      useDrag.setState({ drag: { pane, x: e.clientX, y: e.clientY, sx: w.sx, sy: w.sy, outside: canDetach(useUI.getState(), pane) } });
      return;
    }
    if (w.in === "other") {
      if (away !== w.window) leave();
      away = w.window;
      local.stop();
      void bridge().sendWindow(w.window, "dragover", { title, x: w.x, y: w.y }).catch(() => {});
      useDrag.setState({ drag: { pane, x: e.clientX, y: e.clientY, away: w.window } });
      return;
    }
    leave();
    local.at(e.clientX, e.clientY);
    useDrag.setState({ drag: { pane, x: e.clientX, y: e.clientY, ...targetAt(useUI.getState(), pane, e.clientX, e.clientY) } });
  };
  /** Asks where the pointer is (one question at a time; the latest move counts). */
  const locate = () => {
    if (asking || !last) return;
    const e = last;
    last = undefined;
    // the pointer inside this page: here, without asking (also when the OS is asked: no round trip for the common case)
    const inside = e.clientX >= 0 && e.clientY >= 0 && e.clientX < window.innerWidth && e.clientY < window.innerHeight;
    if (inside || !native) {
      at(e, inside ? { in: "here" } : whereByPage(wins, e));
      return;
    }
    asking = true;
    bridge()
      .pointer()
      .then(
        (p) => at(e, whereByOS(p)),
        () => {
          // the browser build: no native windows
          native = false;
          at(e, whereByPage(wins, e));
        },
      )
      .finally(() => {
        asking = false;
        if (!ended) locate();
      });
  };

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < THRESHOLD) return;
      dragging = true;
      document.body.style.cursor = "grabbing";
    }
    last = e;
    locate();
  };
  // where on the grip it was grabbed: the new window opens with the pane where it was grabbed under the pointer
  // (its tab bar above the pane)
  const grab = (() => {
    const r = document.querySelector(`[data-pane="${CSS.escape(pane)}"]`)?.getBoundingClientRect();
    return r ? { x: down.clientX - r.left, y: down.clientY - r.top + TAB_BAR } : { x: 0, y: TAB_BAR };
  })();
  const end = async (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    ended = true;
    local.stop();
    document.body.style.cursor = cursor;
    const d = useDrag.getState().drag;
    useDrag.setState({ drag: undefined });
    if (drop && d?.outside && d.sx !== undefined && d.sy !== undefined) {
      answer = undefined;
      void detachPane(pane, { x: d.sx - grab.x, y: d.sy - grab.y });
      return;
    }
    if (drop && d?.away && away) {
      // the window under the pointer says where the pane goes (its last answer may still be on the way)
      const to = away;
      const where = await new Promise<S.MoveTarget | undefined>((resolve) => {
        const timer = window.setTimeout(() => resolve(remote), DROP_WAIT);
        dropAnswer = (t) => (clearTimeout(timer), resolve(t));
        void bridge().sendWindow(to, "dragdrop", {}).catch(() => (clearTimeout(timer), resolve(undefined)));
      });
      answer = undefined;
      away = undefined;
      if (where) void sendPane(pane, to, where);
      return;
    }
    answer = undefined;
    leave();
    if (drop && d?.target) setUI((s) => S.movePane(s, pane, d.target!));
    else if (dragging) {
      setUI((s) => {
        const i = s.tabs.findIndex((t) => t.id === startTab);
        return i >= 0 && i !== s.activeTab ? { ...s, activeTab: i } : s;
      });
    }
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

/**
 * This window as the target of another window's drag: shows where the pane
 * would land (the same targets as a drag in here, the tab dwell included) and
 * tells the dragging window, which hands the pane over on release.
 */
export function listenForDrags() {
  const update = (v: Omit<Visit, "target" | "rect">, drop = false) => {
    const t = targetAt(useUI.getState(), undefined, v.x, v.y);
    useVisit.setState({ visit: drop ? undefined : { ...v, ...t } });
    void bridge().sendWindow(v.from, "dragtarget", { target: t.target, drop }).catch(() => {});
  };
  const dwell = dweller(() => {
    const v = useVisit.getState().visit;
    if (v) update(v);
  });
  onDragMessage((m: WindowMessage) => {
    if (m.kind === "dragtarget") answer?.(m);
    else if (m.kind === "dragover") {
      // the point in this window's page (the app: from the OS; the browser build: from the window's frame)
      const { title, x, y } = m.data as { title: string; x: number; y: number };
      dwell.at(x, y);
      update({ from: m.from, title, x, y });
    } else if (m.kind === "dragdrop") {
      // released here: the target at the last point, final
      dwell.stop();
      const v = useVisit.getState().visit;
      if (v && v.from === m.from) update(v, true);
      else void bridge().sendWindow(m.from, "dragtarget", { drop: true }).catch(() => {});
    } else if (m.kind === "dragleave") {
      dwell.stop();
      useVisit.setState({ visit: undefined });
    }
  });
}

const paneLabel = (pane: S.PaneState | undefined) => pane?.name ?? (pane?.term ? `${pane.term.pod}/${pane.term.container}` : paneTitle(pane));

/** Shows the grip while the mouse moves over the pane, and a little after. */
function useHover(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  const [shown, setShown] = useState(false);
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
  }, [active]);
  return shown;
}

/**
 * A pane's grip, top center: shown while the mouse moves over the pane (and
 * a little after), or while it's on the grip itself; never when there is
 * nowhere to move the pane to: the only pane of a window, with no other
 * window to go to, and already a window of its own.
 */
export function Grip({ id }: { id: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  // somewhere to go: another pane here (next to it, its own tab, or out into a window of its own), or another
  // window; the one pane there is has none (a window of its own would be the same thing)
  const elsewhere = useWindows((w) => otherWindows(w.names).length > 0);
  const movable = useUI((s) => s.tabs.reduce((n, t) => n + paneIds(t.layout).length, 0) > 1) || elsewhere;
  const dragged = useDrag((d) => d.drag?.pane === id);
  // during a drag only the dragged pane's grip shows: the others would be noise over the targets
  const anyDrag = useDrag((d) => !!d.drag);
  const shown = useHover(ref, movable);
  const visible = dragged || (shown && !anyDrag);

  if (!movable) return null;
  return (
    <button
      ref={ref}
      type="button"
      aria-label="move pane"
      title="drag to move the pane: next to another one, to a tab's edge, onto a tab or + (a new tab), into another window, or out of the window (a window of its own)"
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
  const visit = useVisit((v) => v.visit);
  const pane = useUI((s) => (drag ? s.panes[drag.pane] : undefined));
  // out of this window, the pane under the drag shows it's leaving (the label at the pointer is out of sight)
  const leaving = drag && (drag.outside || drag.away) ? document.querySelector(`[data-pane="${CSS.escape(drag.pane)}"]`) : null;
  const lr = leaving ? box(leaving) : undefined;
  // over another window, that window shows it
  const shown = drag && !drag.away ? { x: drag.x, y: drag.y, rect: drag.rect, title: drag.outside ? `${paneLabel(pane)} → new window` : paneLabel(pane) } : visit ? { x: visit.x, y: visit.y, rect: visit.rect, title: visit.title } : undefined;
  if (!shown && !lr) return null;
  const r = shown?.rect;
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {lr ? (
        <div
          aria-label="leaving pane"
          className="absolute flex items-center justify-center bg-bg/70 backdrop-grayscale"
          style={{ left: lr.x, top: lr.y, width: lr.w, height: lr.h }}
        >
          <span className="rounded border border-accent bg-bg-elev px-3 py-1 text-fg shadow-menu">{drag!.away ? "↗ moves to the other window" : "↗ opens in a new window"}</span>
        </div>
      ) : null}
      {r ? (
        <div
          aria-label="drop target"
          className="absolute border-2 border-accent bg-accent/25"
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        />
      ) : null}
      {shown ? (
        <div
          aria-label="moving pane"
          className="absolute border border-accent bg-bg-elev px-2 py-0.5 text-fg shadow-menu"
          style={{ left: shown.x + 12, top: shown.y + 12 }}
        >
          {shown.title}
        </div>
      ) : null}
    </div>
  );
}
