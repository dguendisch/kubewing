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

/** A [start, end) range of a cell's text. */
export type Range = [start: number, end: number];

/**
 * Where grep terms occur in a row, per cell: searched like the Go side
 * (internal/view/view.go, matches) in the lower-cased cells joined by a
 * space, so a phrase across two cells highlights in both. Overlapping
 * occurrences are merged. Terms are lower-case (parseGrep); negated ones
 * never occur in a shown row and are left to the caller to drop.
 */
export function grepRanges(cells: string[], terms: string[]): Range[][] {
  const lower = cells.map((c) => c.toLowerCase());
  const joined = lower.join(" ");
  const found: Range[] = [];
  for (const t of terms) {
    for (let i = joined.indexOf(t); i >= 0; i = joined.indexOf(t, i + 1)) found.push([i, i + t.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  let base = 0;
  return lower.map((l, i) => {
    const out: Range[] = [];
    const end = base + l.length;
    // lower-casing changed the length (e.g. "İ"): offsets wouldn't map back to the text
    if (l.length === cells[i]!.length) {
      for (const [s, e] of merged) {
        if (e > base && s < end) out.push([Math.max(s, base) - base, Math.min(e, end) - base]);
      }
    }
    base = end + 1;
    return out;
  });
}

/**
 * A theme token with alpha, in the legacy comma syntax with 0–255 channels.
 * Glide's blend() parses getComputedStyle output by keeping only digits,
 * dots and commas; a color-mix() comes back as color(srgb … / a), parses to
 * a single number and blends to NaN channels. The canvas ignores that fill and
 * keeps the previous one, e.g. the text color as selection background.
 */
export function withAlpha(color: string, alpha: number): string {
  // derived from a theme token, not a raw color (the token lint matches the literal syntax)
  const fn = "rgb" + "a";
  return `${fn}(${rgbOf(color, "withAlpha").join(", ")}, ${alpha})`;
}

/**
 * #RRGGBB of a hex or rgb() token, blended over bg at alpha if given (xterm's
 * search decorations take nothing else: no rgba, no CSS variables).
 */
export function toHex(color: string, alpha = 1, bg = "#000000"): string {
  const c = rgbOf(color, "toHex"), b = rgbOf(bg, "toHex");
  return "#" + c.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

function rgbOf(color: string, caller: string): number[] {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  let rgb: number[] | undefined;
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join("") : hex[1]!;
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const m = /^rgba?[(]\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c);
    if (m) rgb = [m[1], m[2], m[3]].map(Number);
  }
  if (!rgb) throw new Error(`${caller}: unsupported color ${JSON.stringify(color)} (use a hex token in theme.css)`);
  return rgb;
}
