/**
 * Moving a pane, or a whole tab of them, to another window. Each window has
 * its own UI state, so the pane is handed over: its state goes to the other window, and what Go runs
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
import { windowName } from "./window";

/** What travels with each pane: its state, a shell's screen, a log pane's lines, a table's timeline. */
export interface PaneHandoff {
  pane: S.PaneState;
  /** A shell's transcript (base64 chunks; the exit, if it ended). */
  transcript?: { data?: string; exit?: string | number }[];
  logs?: { lines: LogLine[]; streams: LogStream[]; dropped: number };
  timeline?: Timeline;
}

/** A pane handed over, to land at `to`. */
export interface Handoff extends PaneHandoff {
  to: S.MoveTarget;
}

/** A tab handed over with its panes, to land at index `at` of the tab bar. */
export interface TabHandoff {
  tab: S.Tab;
  panes: PaneHandoff[];
  at: number;
}

const sessionOf = (p: S.PaneState) => p.term?.session ?? p.logs?.session;

function encode(u: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Hands panes of this window to another one: what Go runs for them sends
 * its events there from now on, and `send` gets their snapshots to send
 * along. Then they leave this window (`leave`, as if closed; a detached
 * window left empty closes), but what they run lives on there.
 */
async function handOver(paneIds: string[], target: string, send: (panes: PaneHandoff[]) => Promise<void>, leave: (s: S.UIState) => S.UIState): Promise<void> {
  const t = bridge();
  const all = useUI.getState().panes;
  const moving = paneIds.map((id) => all[id]).filter((p): p is S.PaneState => !!p);
  if (!moving.length) return;
  // a split object view borrows its table's watch: it keeps it if its table comes along, else it opens its own there
  const owned = new Set(moving.filter((p) => p.serverId && !p.leased).map((p) => p.serverId));
  const panes = moving.map((p) => (p.leased && !owned.has(p.serverId) ? { ...p, serverId: undefined, leased: undefined, opening: false } : p));
  const servers = [...new Set(panes.map((p) => p.serverId).filter((x): x is string => !!x))];
  const sessionIds = panes.map(sessionOf).filter((x): x is string => !!x);
  const ids = [...servers, ...sessionIds];
  for (const id of ids) handedOff.add(id);
  let cut: Record<string, number> = {};
  try {
    if (ids.length) cut = await t.reassign(ids, target);
  } catch (e) {
    for (const id of ids) handedOff.delete(id);
    throw e;
  }
  await Promise.all(sessionIds.filter((id) => cut[id] !== undefined).map((id) => waitFor(id, cut[id]!)));
  const snapshots = panes.map((pane) => {
    const h: PaneHandoff = { pane: { ...pane, flash: undefined } };
    if (pane.term) h.transcript = sessions.snapshot(pane.term.session).map((c) => (c instanceof Uint8Array ? { data: encode(c) } : { exit: c.exit }));
    if (pane.logs) {
      const b = logBuffers.get(pane.logs.session);
      h.logs = { lines: b.lines, streams: b.streams, dropped: b.dropped };
    }
    if (pane.serverId) h.timeline = useTimelines.getState().byPane[pane.serverId];
    return h;
  });
  try {
    await send(snapshots);
  } catch (e) {
    // still here: back to this window
    if (ids.length) await t.reassign(ids, windowName).catch(() => {});
    for (const id of ids) handedOff.delete(id);
    throw e;
  }
  const gone = new Set(moving.map((p) => p.id));
  setUI((s) => {
    s = leave(s);
    // a split object view staying here loses the watch it borrowed from a table that left: it opens its own
    for (const p of Object.values(s.panes)) {
      if (!gone.has(p.id) && p.leased && p.serverId && servers.includes(p.serverId)) s = S.updatePane(s, p.id, (q) => ({ ...q, serverId: undefined, leased: undefined, opening: false }));
    }
    return s;
  });
  for (const id of servers) {
    paneData.drop(id);
    setTimeline(id, undefined);
  }
  for (const id of sessionIds) {
    sessions.drop(id);
    logBuffers.drop(id);
  }
  for (const id of ids) {
    forgetSeq(id);
    handedOff.delete(id);
  }
}

/**
 * Sends a pane of this window to another one, to land at `to` there. The
 * pane leaves this window once it's on its way; if this was its last, the
 * window closes (the main one stays, with a fresh pane).
 */
export async function sendPane(paneId: string, target: string, to: S.MoveTarget): Promise<void> {
  await handOver(
    [paneId],
    target,
    ([h]) => bridge().sendWindow(target, "handoff", { ...h!, to } satisfies Handoff),
    (s) => S.closePane(s, paneId),
  );
}

/**
 * Sends a tab of this window, with all its panes, to another one, to land
 * at index `at` of its tab bar. If it was this window's last tab, the window
 * closes (the main one stays, with a fresh tab).
 */
export async function sendTab(tabId: string, target: string, at: number): Promise<void> {
  const tab = useUI.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  await handOver(
    paneIds(tab.layout),
    target,
    (panes) => bridge().sendWindow(target, "handofftab", { tab, panes, at } satisfies TabHandoff),
    (s) => {
      const i = s.tabs.findIndex((t) => t.id === tabId);
      return i < 0 ? s : S.closeTab(s, i);
    },
  );
}

/** What arrives with a pane, before it's in the layout: its screen, lines and timeline. */
function restore(h: PaneHandoff) {
  if (h.pane.term && h.transcript) {
    sessions.prepend(
      h.pane.term.session,
      h.transcript.map((c) => (c.data !== undefined ? b64decode(c.data) : { exit: c.exit ?? "" })),
    );
  }
  if (h.pane.logs && h.logs) logBuffers.prepend(h.pane.logs.session, h.logs);
  if (h.pane.serverId && h.timeline) setTimeline(h.pane.serverId, h.timeline);
}

/** Once the panes are in the layout: complete frames, and the exits of sessions that ended on the way. */
function settle(panes: S.PaneState[]) {
  // the next frame has everything, not only what changed since the last one the old window got
  for (const id of new Set(panes.map((p) => p.serverId).filter((x): x is string => !!x))) void bridge().resync(id).catch(() => {});
  for (const p of panes) {
    const session = sessionOf(p);
    const exit = session ? earlyExits.get(session) : undefined;
    if (session && exit !== undefined) {
      earlyExits.delete(session);
      setUI((s) => S.sessionEnded(s, session, exit));
    }
  }
}

/** A pane handed over by another window arrives: it joins this window's layout. */
export function receivePane(h: Handoff) {
  restore(h);
  let id = "";
  setUI((s) => {
    const r = S.insertPane(s, h.pane, S.canInsert(s, h.to) ? h.to : { newTab: true });
    id = r.id;
    return r.state;
  });
  settle([h.pane]);
  return id;
}

/** A tab handed over by another window arrives with its panes: it joins this window's tab bar. */
export function receiveTab(h: TabHandoff) {
  for (const p of h.panes) restore(p);
  setUI((s) => S.insertTab(s, h.tab, h.panes.map((p) => p.pane), h.at).state);
  settle(h.panes.map((p) => p.pane));
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

/** Whether the tab can leave for a window of its own: not the only tab of a detached window (it already is one). */
export function canDetachTab(s: S.UIState, tabId: string): boolean {
  return s.tabs.some((t) => t.id === tabId) && (!s.detached || s.tabs.length > 1);
}

/**
 * Detaches a tab with its panes into a new window of its own (its header
 * dragged out of every window), as big as the tab's panes plus a tab bar.
 * at: the new window's top-left on screen (where it was dropped), else
 * where the tab is.
 */
export async function detachTab(tabId: string, at?: { x: number; y: number }): Promise<void> {
  if (!canDetachTab(useUI.getState(), tabId)) return;
  const r = document.querySelector(`[data-tab-area="${CSS.escape(tabId)}"]`)?.getBoundingClientRect();
  // a hidden tab has no size: the shown one's area is as big
  const size = r?.width ? r : document.querySelector("main")?.getBoundingClientRect();
  const bounds = {
    x: Math.round(at?.x ?? window.screenX + (size?.left ?? 0)),
    y: Math.round(at?.y ?? window.screenY + (size?.top ?? 0) - TAB_BAR),
    w: Math.round(size?.width ?? 0),
    h: size ? Math.round(size.height + TAB_BAR) : 0,
  };
  try {
    const name = await bridge().openWindow(bounds);
    await sendTab(tabId, name, 0);
  } catch (e) {
    const tab = useUI.getState().tabs.find((t) => t.id === tabId);
    if (tab) setUI((s) => S.updatePane(s, tab.focused, (p) => ({ ...p, flash: { text: `couldn't detach: ${String((e as Error).message ?? e)}`, error: true } })));
  }
}

/** A window's tab bar: added to the pane's height so the pane keeps its size in its new window. */
export const TAB_BAR = 28;

/** Messages from other windows: a pane or a tab handed over. */
export function listenForPanes() {
  onWindowMessage((m) => {
    if (m.kind === "handoff") {
      receivePane(m.data as Handoff);
      void focusWindow();
    } else if (m.kind === "handofftab") {
      receiveTab(m.data as TabHandoff);
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
