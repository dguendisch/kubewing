import { create } from "zustand";
import type { Timeline } from "../transport/types";

/**
 * Time-travel state on the client: the timeline of each pane in the past
 * (by server pane id), as the last call returned it. Go owns the moment;
 * frames say whether a pane is in the past (status.at).
 */
export const useTimelines = create<{ byPane: Record<string, Timeline> }>(() => ({ byPane: {} }));

export function setTimeline(serverId: string, tl: Timeline | undefined) {
  useTimelines.setState((s) => {
    const byPane = { ...s.byPane };
    if (tl?.at) byPane[serverId] = tl;
    else delete byPane[serverId];
    return { byPane };
  });
}

const ms = (iso: string) => Date.parse(iso);

/**
 * The moment `delta` ms from the timeline's (clamped to horizon … newest);
 * undefined = live (moved past the newest). Pure.
 */
export function shifted(tl: Timeline, delta: number): string | undefined {
  const at = tl.at ? ms(tl.at) : ms(tl.newest);
  const to = at + delta;
  if (to > ms(tl.newest)) return undefined;
  return new Date(Math.max(ms(tl.horizon), to)).toISOString();
}

/** Where a time sits on the timeline, 0 … 1 (for the bar). Pure. */
export function position(tl: Timeline, iso: string): number {
  const h = ms(tl.horizon);
  const span = ms(tl.newest) - h;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (ms(iso) - h) / span));
}

/** The moment at a position 0 … 1 of the timeline, snapped to the nearest change within `snap` (0 … 1). Pure. */
export function at(tl: Timeline, pos: number, snap = 0.01): string {
  const h = ms(tl.horizon);
  const t = h + Math.min(1, Math.max(0, pos)) * (ms(tl.newest) - h);
  let best: string | undefined;
  let dist = Infinity;
  for (const c of tl.changes) {
    const d = Math.abs(position(tl, c) - pos);
    if (d < dist) [best, dist] = [c, d];
  }
  return best && dist <= snap ? best : new Date(t).toISOString();
}

/** "4m ago", "12s ago" from now. Pure. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s ago` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

/** 3.4 MiB, 512 MiB, 820 KiB. Pure. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) [v, u] = [v / 1024, u + 1];
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** 12:03:14 in local time. Pure. */
export function clock(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
