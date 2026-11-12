import { bridge } from "../store/store";
import { otherWindows, useWindows, windowName } from "../store/window";
import type { PointerInfo, WindowInfo, WindowMessage } from "../transport/types";

/**
 * A drag (a pane's grip, a tab) following the pointer across windows: it
 * works out whether the pointer is in this window, over another kubewing
 * window (at which point of its page), or outside every one. Over another
 * window it tells that window (dragover, with what is dragged), which shows
 * where it would land there and answers with its target (dragtarget); a
 * release over it asks for the final answer (dragdrop). Leaving it says so
 * (dragleave).
 */

/** Where the pointer is during a drag: in this window, in another one (at a point of its page), or outside every one. */
export type Where = { in: "here" } | { in: "other"; window: string; x: number; y: number } | { in: "outside"; sx: number; sy: number };

/** What is being dragged: the receiving window offers its targets for it. */
export type DragKind = "pane" | "tab";

/** What a drag passing over another window tells it (dragover). */
export interface DragOver {
  what?: DragKind;
  title: string;
  x: number;
  y: number;
}

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

/** How long a drop over another window waits for that window to say where the dragged thing goes. */
const DROP_WAIT = 1000;

/** The running drag's handler of answers from the window it's over. */
let answer: ((m: WindowMessage) => void) | undefined;

/** An answer from the window a drag is over (dragtarget): to the running drag. */
export const answerDrag = (m: WindowMessage) => answer?.(m);

export interface WindowDrag<T> {
  /** The pointer moved: works out where it is (one question to the OS at a time; the latest move counts). */
  move(e: PointerEvent): void;
  /**
   * Released: over another window, that window and where it says the
   * dragged thing goes there (its last answer may still be on the way);
   * else undefined.
   */
  drop(): Promise<{ window: string; target?: T } | undefined>;
  /** Cancelled (Esc): the window it was over stops showing it. */
  cancel(): void;
}

/**
 * Follows a drag across windows. onWhere gets each move with where the
 * pointer is; over another window, that window is kept told.
 */
export function windowDrag<T>(what: DragKind, title: string, onWhere: (e: PointerEvent, w: Where) => void): WindowDrag<T> {
  // the app asks the OS where the mouse is and which window is in front there; the browser build (no native
  // windows) falls back to the page's screen coordinates and the windows' frames, asked once
  let native = true;
  let wins: WindowInfo[] = [];
  if (otherWindows(useWindows.getState().names).length) void bridge().windows().then((w) => (wins = w), () => {});
  let ended = false;
  let asking = false;
  let last: PointerEvent | undefined;
  // the window the pointer is over, and the target it last reported
  let away: string | undefined;
  let remote: T | undefined;
  let dropAnswer: ((t: T | undefined) => void) | undefined;
  const leave = () => {
    if (away) void bridge().sendWindow(away, "dragleave", {}).catch(() => {});
    away = undefined;
    remote = undefined;
  };
  answer = (m) => {
    if (m.from !== away) return;
    const d = m.data as { target?: T; drop?: boolean };
    remote = d.target;
    if (d.drop) dropAnswer?.(d.target);
  };

  const at = (e: PointerEvent, w: Where) => {
    if (ended) return; // a late answer, after the drop
    if (w.in === "other") {
      if (away !== w.window) leave();
      away = w.window;
      const over: DragOver = { what, title, x: w.x, y: w.y };
      void bridge().sendWindow(w.window, "dragover", over).catch(() => {});
    } else leave();
    onWhere(e, w);
  };
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

  return {
    move(e) {
      last = e;
      locate();
    },
    async drop() {
      ended = true;
      const to = away;
      if (!to) {
        answer = undefined;
        return undefined;
      }
      const target = await new Promise<T | undefined>((resolve) => {
        const timer = window.setTimeout(() => resolve(remote), DROP_WAIT);
        dropAnswer = (t) => (clearTimeout(timer), resolve(t));
        void bridge().sendWindow(to, "dragdrop", {}).catch(() => (clearTimeout(timer), resolve(undefined)));
      });
      answer = undefined;
      away = undefined;
      return { window: to, target };
    },
    cancel() {
      ended = true;
      leave();
      answer = undefined;
    },
  };
}
