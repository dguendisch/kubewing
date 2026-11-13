import { create } from "zustand";
import type { Location } from "../transport/types";

/**
 * Where panes are (bridge.Location), by cluster and namespace, for their
 * headers and tab titles. Go answers from what it resolved before, without
 * connecting; resolving more (⌘⇧O, ⌘J, ⌥⌘O) can tell more (a seed found
 * managed), so it clears the cache.
 */
export const useLocations = create<Record<string, Location>>(() => ({}));

export const locationKey = (cluster: string, namespace: string) => `${cluster}\u0000${namespace}`;

const pending = new Set<string>();

/** Fetches a pane's location unless cached or on its way. */
export function loadLocation(cluster: string, namespace: string, fetch: (c: string, ns: string) => Promise<Location>) {
  const k = locationKey(cluster, namespace);
  if (useLocations.getState()[k] || pending.has(k)) return;
  pending.add(k);
  fetch(cluster, namespace).then(
    (l) => {
      pending.delete(k);
      useLocations.setState({ [k]: l ?? {} });
    },
    () => pending.delete(k),
  );
}

export const clearLocations = () => useLocations.setState(() => ({}), true);
