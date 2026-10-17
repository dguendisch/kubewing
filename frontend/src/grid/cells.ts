import type { ColumnInfo, RowData } from "../transport/types";

/**
 * Pure cell layout: everything a renderer needs, as data. The Glide draw
 * callback (Table.tsx) is a thin painter over this; tests cover layout().
 */
export type ColorToken = "fg" | "fgMuted" | "added" | "deleted" | "changed";

export interface CellLayout {
  text: string;
  color: ColorToken;
  /** Background tint for changed cells / added / deleted rows. */
  tint?: "added" | "deleted" | "changed";
  /** Draw the "changed, not visible" marker (first column only). */
  hiddenMarker: boolean;
  strike: boolean;
  align: "left" | "right";
}

export function formatAge(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  let s = Math.max(0, Math.floor((now - t) / 1000));
  const d = Math.floor(s / 86400);
  if (d >= 10) return `${d}d`;
  const h = Math.floor((s % 86400) / 3600);
  if (d > 0) return h ? `${d}d${h}h` : `${d}d`;
  const m = Math.floor((s % 3600) / 60);
  if (h >= 10) return `${h}h`;
  if (h > 0) return m ? `${h}h${m}m` : `${h}h`;
  s %= 60;
  if (m >= 10) return `${m}m`;
  if (m > 0) return s ? `${m}m${s}s` : `${m}m`;
  return `${s}s`;
}

export function layout(row: RowData | undefined, col: number, column: ColumnInfo | undefined, now: number): CellLayout {
  if (!row || !column) return { text: "", color: "fgMuted", hiddenMarker: false, strike: false, align: "left" };
  const raw = row.cells[col] ?? "";
  const text = column.type === "age" ? formatAge(raw, now) : raw;
  const numeric = column.type === "number" || column.type === "bytes";
  const base: CellLayout = { text, color: "fg", hiddenMarker: false, strike: false, align: numeric ? "right" : "left" };
  if (row.mark === "deleted") return { ...base, color: "deleted", tint: "deleted", strike: true };
  if (row.mark === "added") return { ...base, color: "added", tint: "added" };
  if (row.changed?.includes(col)) return { ...base, color: "changed", tint: "changed" };
  if (column.type === "age") return { ...base, color: "fgMuted", hiddenMarker: col === 0 && !!row.hidden };
  return { ...base, hiddenMarker: col === 0 && !!row.hidden };
}
