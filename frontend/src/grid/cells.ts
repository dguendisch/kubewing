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

/** Columns whose cells the frontend renders against its clock (shown text ≠ cell text): they tick. */
export function clockRendered(c: ColumnInfo | undefined): boolean {
  return c?.type === "age" || c?.type === "restarts";
}

/** A cell as shown: an age cell's timestamp as "5m", a restarts cell's "3 (<timestamp>)" as "3 (5m ago)"; else as is. */
export function shownText(raw: string, column: ColumnInfo | undefined, now: number): string {
  if (!raw) return raw;
  if (column?.type === "age") return formatAge(raw, now);
  if (column?.type === "restarts") {
    const m = /^(\S+) \((.+)\)$/.exec(raw);
    if (m && !Number.isNaN(Date.parse(m[2]!))) return `${m[1]} (${formatAge(m[2]!, now)} ago)`;
  }
  return raw;
}

export function layout(row: RowData | undefined, col: number, column: ColumnInfo | undefined, now: number): CellLayout {
  if (!row || !column) return { text: "", color: "fgMuted", hiddenMarker: false, strike: false, align: "left" };
  const raw = row.cells[col] ?? "";
  const text = shownText(raw, column, now);
  const numeric = column.type === "number" || column.type === "bytes" || column.type === "restarts";
  const base: CellLayout = { text, color: "fg", hiddenMarker: false, strike: false, align: numeric ? "right" : "left" };
  if (row.mark === "deleted") return { ...base, color: "deleted", tint: "deleted", strike: true };
  if (row.mark === "added") return { ...base, color: "added", tint: "added" };
  if (row.changed?.includes(col)) return { ...base, color: "changed", tint: "changed" };
  if (column.type === "age") return { ...base, color: "fgMuted", hiddenMarker: col === 0 && !!row.hidden };
  return { ...base, hiddenMarker: col === 0 && !!row.hidden };
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
 * #RRGGBB of a hex or RGB token, blended over bg at alpha (bg needed below 1;
 * xterm's search decorations take nothing else: no alpha, no CSS variables).
 */
export function toHex(color: string, alpha = 1, bg?: string): string {
  const c = rgbOf(color, "toHex"), b = bg === undefined ? c : rgbOf(bg, "toHex");
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

/** One entry of the copy-cell picker (⌘⇧C): the whole row, or a cell of the row (of each marked row). */
export interface CellChoice {
  /** The column's name ("whole row" for the first entry). */
  label: string;
  /** What ⏎ copies. */
  text: string;
  /** How the table shows it, where that differs from what's copied (an age column's "5m", a restarts column's "3 (5m ago)"). */
  shown?: string;
  /** Why it can't be copied; undefined = it can. */
  disabled?: string;
}

export const wholeRow = "whole row";

/**
 * The picker's entries: the whole row (tab-separated, so it pastes into a
 * spreadsheet's columns), then every shown column in table order with the
 * row's value. With several rows (the marked ones) each entry copies them
 * all, a line each, and shows the first row's value. An age or restarts
 * column copies its timestamp: a "5m" goes stale once pasted. Empty cells
 * are listed but skipped (with several rows: if every row's is empty). Pure.
 */
export function cellChoices(rows: Pick<RowData, "cells">[], columns: ColumnInfo[], now: number): CellChoice[] {
  const more = rows.length > 1 ? ` … +${rows.length - 1}` : "";
  const cells = columns.map((c, i): CellChoice => {
    const texts = rows.map((r) => r.cells[i] ?? "");
    const first = texts[0] ?? "";
    const shown = shownText(first, c, now);
    const text = texts.join("\n");
    return {
      label: c.name,
      text,
      shown: more ? `${shown || "—"}${more}` : shown === text ? undefined : shown,
      disabled: texts.some(Boolean) ? undefined : "empty",
    };
  });
  if (columns.length < 2) return cells;
  const whole = rows.map((r) => columns.map((_, i) => r.cells[i] ?? "").join("\t")).join("\n");
  return [{ label: wholeRow, text: whole, shown: more ? `${rows.length} rows, tab-separated` : "tab-separated" }, ...cells];
}

/** Initially highlighted: the given column (right-clicked, or copied last) if it can be copied, else the first that can. */
export function initialCell(choices: CellChoice[], column?: string): number {
  const i = column === undefined ? -1 : choices.findIndex((c) => c.label === column && !c.disabled);
  return i >= 0 ? i : Math.max(0, choices.findIndex((c) => !c.disabled));
}

/** "36% (1,500/4,213)": the server's total is an estimate, so the share never shows 100% before the list is done. */
export function syncProgress(loaded: number, total: number): string {
  const pct = Math.min(99, Math.floor((loaded / total) * 100));
  return `${pct}% (${loaded.toLocaleString("en-US")}/${total.toLocaleString("en-US")})`;
}
