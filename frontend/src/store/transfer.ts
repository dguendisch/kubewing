/**
 * Moving a pane to another window. Each window has its own UI state, so the
 * pane is handed over: its state goes to the other window, and what Go runs
 * for it (the table's watch, a shell, a log tail) stays as it is and sends
 * its events there from then on (Reassign). The pane arrives as it was: its
 * filters, history, a shell's screen (the transcript), a log pane's backlog,
 * the moment it was scrubbed back to.
 *
 * A shell's output and a log tail's lines are numbered: Reassign says the
 * number of the last one sent here; this window hands over everything up to
 * it, the other one keeps what arrives after. Nothing is lost or doubled
 * even while the shell keeps printing.
 */
import type { Timeline, LogLine, LogStream, WindowMessage } from "../transport/types";
import { sessions, b64decode } from "../term/sessions";
import { logBuffers } from "../logs/buffer";
import { setTimeline, useTimelines } from "./travel";
import { bridge, onWindowMessage, paneData, setUI, useUI } from "./store";
import { paneIds } from "./layout";
import * as S from "./state";
import { earlyExits, forgetSeq, handedOff, waitFor } from "./streams";

/** What travels with a pane. */
export interface Handoff {
  pane: S.PaneState;
  to: S.MoveTarget;
  /** A shell's transcript (base64 chunks; the exit, if it ended). */
  transcript?: { data?: string; exit?: string | number }[];
  logs?: { lines: LogLine[]; streams: LogStream[]; dropped: number };
  timeline?: Timeline;
}

const sessionOf = (p: S.PaneState) => p.term?.session ?? p.logs?.session;

function encode(u: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Sends a pane of this window to another one, to land at `to` there. The
 * pane leaves this window once it's on its way; if this was its last, the
 * window closes (the main one stays, with a fresh pane).
 */
export async function sendPane(paneId: string, target: string, to: S.MoveTarget): Promise<void> {
  const t = bridge();
  let pane = useUI.getState().panes[paneId];
  if (!pane) return;
  // a split object view borrows its table's watch, which stays here: it opens its own there
  if (pane.leased) pane = { ...pane, serverId: undefined, leased: undefined, opening: false };
  const session = sessionOf(pane);
  const ids = [pane.serverId, session].filter((x): x is string => !!x);
  for (const id of ids) handedOff.add(id);
  let cut: Record<string, number> = {};
  try {
    if (ids.length) cut = await t.reassign(ids, target);
  } catch (e) {
    for (const id of ids) handedOff.delete(id);
    throw e;
  }
  if (session && cut[session] !== undefined) await waitFor(session, cut[session]!);
  const h: Handoff = { pane: { ...pane, flash: undefined }, to };
  if (pane.term) {
    h.transcript = sessions.snapshot(pane.term.session).map((c) => (c instanceof Uint8Array ? { data: encode(c) } : { exit: c.exit }));
  }
  if (pane.logs) {
    const b = logBuffers.get(pane.logs.session);
    h.logs = { lines: b.lines, streams: b.streams, dropped: b.dropped };
  }
  if (pane.serverId) h.timeline = useTimelines.getState().byPane[pane.serverId];
  await t.sendWindow(target, "handoff", h);
  // gone from here, as if closed (a detached window left empty closes), but what it runs lives on there
  setUI((s) => S.closePane(s, paneId));
  for (const id of ids) {
    if (id === pane.serverId) paneData.drop(id);
    else {
      sessions.drop(id);
      logBuffers.drop(id);
    }
    forgetSeq(id);
    handedOff.delete(id);
  }
  if (pane.serverId) setTimeline(pane.serverId, undefined);
}

/** A pane handed over by another window arrives: it joins this window's layout. */
export function receivePane(h: Handoff) {
  const session = sessionOf(h.pane);
  if (h.pane.term && h.transcript) {
    sessions.prepend(
      h.pane.term.session,
      h.transcript.map((c) => (c.data !== undefined ? b64decode(c.data) : { exit: c.exit ?? "" })),
    );
  }
  if (h.pane.logs && h.logs) logBuffers.prepend(h.pane.logs.session, h.logs);
  if (h.pane.serverId && h.timeline) setTimeline(h.pane.serverId, h.timeline);
  let id = "";
  setUI((s) => {
    const r = S.insertPane(s, h.pane, S.canInsert(s, h.to) ? h.to : { newTab: true });
    id = r.id;
    return r.state;
  });
  // the next frame has everything, not only what changed since the last one the old window got
  if (h.pane.serverId) void bridge().resync(h.pane.serverId).catch(() => {});
  if (session) {
    const exit = earlyExits.get(session);
    if (exit !== undefined) {
      earlyExits.delete(session);
      setUI((s) => S.sessionEnded(s, session, exit));
    }
  }
  return id;
}

/** Whether the pane can leave for a window of its own: not the only pane of a detached window (it already is one). */
export function canDetach(s: S.UIState, paneId: string): boolean {
  if (!s.panes[paneId]) return false;
  const panes = s.tabs.reduce((n, t) => n + paneIds(t.layout).length, 0);
  return !s.detached || panes > 1;
}

/**
 * Detaches a pane into a new window of its own (its grip dropped outside
 * every window), as big as the pane; the pane is its only tab there. at:
 * the new window's top-left on screen (where it was dropped), else where
 * the pane is.
 */
export async function detachPane(paneId: string, at?: { x: number; y: number }): Promise<void> {
  if (!canDetach(useUI.getState(), paneId)) return;
  const el = document.querySelector(`[data-pane="${CSS.escape(paneId)}"]`);
  const r = el?.getBoundingClientRect();
  // the page's top-left on screen is the window's (no title bar: hidden)
  const bounds = r
    ? { x: Math.round(at?.x ?? window.screenX + r.left), y: Math.round(at?.y ?? window.screenY + r.top), w: Math.round(r.width), h: Math.round(r.height + TAB_BAR) }
    : { x: Math.round(at?.x ?? 0), y: Math.round(at?.y ?? 0), w: 0, h: 0 };
  try {
    const name = await bridge().openWindow(bounds);
    await sendPane(paneId, name, { newTab: true });
  } catch (e) {
    setUI((s) => S.updatePane(s, paneId, (p) => ({ ...p, flash: { text: `couldn't detach: ${String((e as Error).message ?? e)}`, error: true } })));
  }
}

/** A window's tab bar: added to the pane's height so the pane keeps its size in its new window. */
export const TAB_BAR = 28;

/** Messages from other windows: a pane handed over. */
export function listenForPanes() {
  onWindowMessage((m) => {
    if (m.kind === "handoff") {
      receivePane(m.data as Handoff);
      void focusWindow();
    } else dragMessage?.(m);
  });
}

/** Drag messages (another window's drag passing over this one); set by PaneDrag. */
let dragMessage: ((m: WindowMessage) => void) | undefined;
export function onDragMessage(f: typeof dragMessage) {
  dragMessage = f;
}

/** Brings this window to the front (a pane just arrived in it). */
async function focusWindow() {
  window.focus();
}
