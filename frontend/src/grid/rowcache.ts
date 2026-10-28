import type { ColumnInfo, Frame, RowData, Status } from "../transport/types";

/** Client-side mirror of the server viewport window. Pure; see rowcache.test.ts. */
export interface PaneData {
  seq: number;
  columns: ColumnInfo[];
  total: number;
  offset: number;
  order: string[];
  rows: Map<string, RowData>;
  status: Status;
}

export const emptyPane = (): PaneData => ({
  seq: 0,
  columns: [],
  total: 0,
  offset: 0,
  order: [],
  rows: new Map(),
  status: { synced: false, objects: 0 },
});

/** Applies a frame following the contract in internal/view/frame.go. */
export function applyFrame(prev: PaneData, f: Frame): PaneData {
  if (f.seq <= prev.seq) return prev; // stale/duplicate
  const rows = f.columns ? new Map<string, RowData>() : new Map(prev.rows);
  for (const r of f.rows ?? []) rows.set(r.key, r);
  const inWindow = new Set(f.order);
  for (const k of rows.keys()) if (!inWindow.has(k)) rows.delete(k);
  return {
    seq: f.seq,
    columns: f.columns ?? prev.columns,
    total: f.total,
    offset: f.offset,
    order: f.order,
    rows,
    status: f.status ?? prev.status,
  };
}

/** Row at absolute index, or undefined when outside the window. */
export function rowAt(p: PaneData, index: number): RowData | undefined {
  const k = p.order[index - p.offset];
  return k === undefined ? undefined : p.rows.get(k);
}

/** What age cells count from: the moment shown while in the past (time travel), else now. */
export function nowOf(p: PaneData): number {
  return p.status.at ? Date.parse(p.status.at) : Date.now();
}
