import { create } from "zustand";
import type { Transport } from "../transport/types";
import { applyFrame, emptyPane, type PaneData } from "../grid/rowcache";
import { b64decode, sessions } from "../term/sessions";
import type { ContextList, PortForward, TypeView } from "../transport/types";
import { menuSpec } from "../keys/appMenu";
import type { Binding } from "../keys/keymap";
import { applyConfig, useConfig } from "./config";
import { clearRules } from "./rules";
import { clearLocations } from "./location";
import { checkFollow, contextNamespace, emptyState, initialState, pickClusterState, logsEnded, orphanedEdits, orphanedServerPanes, orphanedSessions, paneFocus, sessionEnded, touchTab, type UIState } from "./state";
import { logBuffers } from "../logs/buffer";
import { useUpdate } from "../update/update";
import { earlyExits, forgetSeq, handedOff, receivedSeq } from "./streams";
import { isMainWindow, useWindows, windowName } from "./window";

/**
 * UI state (layout, focus, overlays) lives in a React-subscribed store.
 * High-frequency pane data lives outside React: grids subscribe directly
 * and repaint via Glide's updateCells, bypassing re-render.
 */
export const useUI = create<UIState>(() => (isMainWindow ? initialState() : emptyState()));

/** Kubeconfig contexts: kubewing's own loaded before the first render; ⌘O re-reads its pane's kubeconfig's. */
export const useContexts = create<{ list?: ContextList }>(() => ({}));

/** All UI updates go through here; touchTab keeps the MRU tab order in sync, checkFollow the object views following a table. */
export const setUI = (f: (s: UIState) => UIState) =>
  useUI.setState((s) => {
    const next = f(s);
    // a window between panes (its pane on the way, or its last one gone as it closes) has nothing to keep in sync
    return next.tabs.length === 0 ? next : paneFocus(touchTab(checkFollow(next)));
  }, true);

type Listener = (d: PaneData) => void;

class PaneDataStore {
  private data = new Map<string, PaneData>();
  private listeners = new Map<string, Set<Listener>>();

  get(serverId: string): PaneData {
    return this.data.get(serverId) ?? emptyPane();
  }

  apply(serverId: string, f: Parameters<typeof applyFrame>[1]) {
    const next = applyFrame(this.get(serverId), f);
    this.data.set(serverId, next);
    this.listeners.get(serverId)?.forEach((l) => l(next));
  }

  subscribe(serverId: string, l: Listener): () => void {
    let set = this.listeners.get(serverId);
    if (!set) this.listeners.set(serverId, (set = new Set()));
    set.add(l);
    return () => set.delete(l);
  }

  drop(serverId: string) {
    this.data.delete(serverId);
    this.listeners.delete(serverId);
  }
}

export const paneData = new PaneDataStore();

/** Active port-forwards (pushed by Go on every change). */
export const usePortForwards = create<{ list: PortForward[] }>(() => ({ list: [] }));

/** Column settings per resource type (columns.yaml; pushed by Go on every change). */
export const useColumns = create<{ types: Record<string, TypeView> }>(() => ({ types: {} }));

let transport: Transport | undefined;

/** Messages from other windows (a pane handed over, a drag passing over); set by transfer/drag code. */
let windowMessage: ((m: import("../transport/types").WindowMessage) => void) | undefined;
export function onWindowMessage(f: typeof windowMessage) {
  windowMessage = f;
}

export function connect(t: Transport) {
  transport = t;
  t.onFrame((p) => paneData.apply(p.pane, p.frame));
  // a session's pane may not be here yet: it's on its way from another window (its exit waits for it)
  const sessionHere = (id: string) => Object.values(useUI.getState().panes).some((p) => (p.term?.session ?? p.logs?.session) === id);
  t.onSession((p) => {
    receivedSeq(p.id, p.seq);
    if (p.data) sessions.push(p.id, b64decode(p.data));
    if (p.exit !== undefined && p.exit !== "") {
      sessions.push(p.id, { exit: p.exit });
      if (sessionHere(p.id)) setUI((x) => sessionEnded(x, p.id, p.exit!));
      else earlyExits.set(p.id, p.exit);
    }
  });
  t.onLogs((p) => {
    receivedSeq(p.id, p.seq);
    if (p.streams) logBuffers.setStreams(p.id, p.streams);
    if (p.lines?.length || p.dropped) logBuffers.pushLines(p.id, p.lines ?? [], p.dropped);
    if (p.exit !== undefined && p.exit !== "") {
      if (sessionHere(p.id)) setUI((x) => logsEnded(x, p.id, p.exit!));
      else earlyExits.set(p.id, p.exit);
    }
  });
  t.onWindow((m) => {
    if (m.kind === "windows") useWindows.setState({ names: (m.data as string[]) ?? [] });
    else windowMessage?.(m);
  });
  t.onPortForwards((l) => usePortForwards.setState({ list: l }, true));
  t.portForwards().then((l) => usePortForwards.setState({ list: l }, true), () => {});
  t.onUpdate((st) => useUpdate.setState({ status: st }));
  t.updateStatus().then((st) => useUpdate.setState({ status: st }), () => {});
  t.onColumns((c) => useColumns.setState({ types: c ?? {} }, true));
  t.columnConfigs().then((c) => useColumns.setState({ types: c ?? {} }, true), () => {});
  t.onConfig((c) => {
    clearRules(); // context rules may have changed; panes refetch on render
    clearLocations(); // so may gardenctl's gardens
    applyConfig(c);
  });
  t.config().then(applyConfig, () => {});
  // the native menu follows the merged keymap (keybindings.yaml); its clicks are dispatched in useKeys
  const sendMenu = (b: Binding[]) => void t.setMenu(menuSpec(b)).catch(() => {});
  sendMenu(useConfig.getState().bindings);
  useConfig.subscribe((next, prev) => {
    if (next.bindings !== prev.bindings) sendMenu(next.bindings);
  });
  // A server pane lives as long as UI state references it, not as long as a
  // component is mounted: hidden tabs and panes re-parented by a split keep their data.
  // What was handed to another window lives on there.
  useUI.subscribe((next, prev) => {
    // a detached window whose last pane closed or left closes too
    if (next.detached && next.tabs.length === 0 && prev.tabs.length > 0) void t.closeWindow(windowName).catch(() => {});
    for (const id of orphanedServerPanes(prev, next)) {
      if (handedOff.has(id)) continue;
      t.close(id).catch(() => {});
      paneData.drop(id);
    }
    for (const id of orphanedSessions(prev, next)) {
      if (handedOff.has(id)) continue;
      t.sessionClose(id).catch(() => {});
      sessions.drop(id);
      logBuffers.drop(id);
      forgetSeq(id);
      earlyExits.delete(id);
    }
    for (const id of orphanedEdits(prev, next)) t.editClose(id).catch(() => {});
  });
}

/**
 * Loads the kubeconfig contexts. Called once before the first render: the
 * first pane then starts in the current context's namespace, if it sets one.
 * Without a current context (no kubeconfig, or none set as current, as a
 * Dock launch may have), the first pane lists nothing and ⌘⇧O picks a cluster.
 */
export async function loadContexts() {
  const list = await bridge().contexts("").catch(() => undefined);
  useContexts.setState({ list });
  // another window starts empty and waits for the pane it was opened for
  if (!isMainWindow) return;
  if (!list?.current) return useUI.setState(pickClusterState(), true);
  const ns = contextNamespace(list, "");
  if (ns) useUI.setState(initialState("", ns), true);
}

export function bridge(): Transport {
  if (!transport) throw new Error("transport not connected");
  return transport;
}
