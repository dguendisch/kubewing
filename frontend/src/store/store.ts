import { create } from "zustand";
import type { Transport } from "../transport/types";
import { applyFrame, emptyPane, type PaneData } from "../grid/rowcache";
import { initialState, orphanedServerPanes, type UIState } from "./state";

/**
 * UI state (layout, focus, overlays) lives in a React-subscribed store.
 * High-frequency pane data lives outside React: grids subscribe directly
 * and repaint via Glide's updateCells, bypassing re-render.
 */
export const useUI = create<UIState>(() => initialState());

export const setUI = (f: (s: UIState) => UIState) => useUI.setState((s) => f(s), true);

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

let transport: Transport | undefined;

export function connect(t: Transport) {
  transport = t;
  t.onFrame((p) => paneData.apply(p.pane, p.frame));
  // A server pane lives as long as UI state references it, not as long as a
  // component is mounted: hidden tabs and panes re-parented by a split keep their data.
  useUI.subscribe((next, prev) => {
    for (const id of orphanedServerPanes(prev, next)) {
      t.close(id).catch(() => {});
      paneData.drop(id);
    }
  });
}

export function bridge(): Transport {
  if (!transport) throw new Error("transport not connected");
  return transport;
}
