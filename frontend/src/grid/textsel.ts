import { create } from "zustand";
import { formatAge } from "./cells";
import type { ColumnInfo, RowData } from "../transport/types";

/**
 * Text selection inside one table cell (the canvas has no DOM text to
 * select): double-click selects a word, triple-click the cell, a drag a
 * range. ⌘C copies it (else the row's name). It belongs to the object and
 * column, not to a screen position, and holds the cell's text as selected:
 * once the cell changes, it's stale and neither drawn nor copied.
 *
 * An age cell is selected whole: it shows "5m" but copies its timestamp.
 */
export interface TextSel {
  /** Row key (object UID). */
  key: string;
  column: string;
  /** The cell's text when selected (an age cell's: its timestamp). */
  text: string;
  /** [start, end) in the shown text; an age cell: the whole of it. */
  start: number;
  end: number;
  age?: boolean;
}

/** Per server pane id. */
export const useTextSel = create<Record<string, TextSel | undefined>>(() => ({}));

export function setTextSel(serverId: string, sel: TextSel | undefined) {
  if (useTextSel.getState()[serverId] === sel) return;
  useTextSel.setState({ [serverId]: sel });
}

/** Separates words: whitespace and list punctuation. Names, IPs, images, label pairs (a=b), paths and ports stay one word. */
const separator = /[\s,;()[\]{}"'<>|]/;

/** The word around char index i ([start, end)), or undefined on a separator / outside the text. Pure. */
export function wordAt(text: string, i: number): [number, number] | undefined {
  if (i < 0 || i >= text.length || separator.test(text[i]!)) return undefined;
  let s = i, e = i + 1;
  while (s > 0 && !separator.test(text[s - 1]!)) s--;
  while (e < text.length && !separator.test(text[e]!)) e++;
  return [s, e];
}

/** The char under x (relative to the text's start), clamped to the text. Pure; measure = prefix width. */
export function charAt(text: string, x: number, measure: (s: string) => number): number {
  let i = 0;
  while (i < text.length - 1 && measure(text.slice(0, i + 1)) <= x) i++;
  return i;
}

/** The char boundary nearest to x (0 … text.length), where a drag starts or ends. Pure. */
export function boundaryAt(text: string, x: number, measure: (s: string) => number): number {
  let best = 0, dist = Math.abs(x);
  for (let i = 1; i <= text.length; i++) {
    const d = Math.abs(measure(text.slice(0, i)) - x);
    if (d < dist) [best, dist] = [i, d];
  }
  return best;
}

/** Where a cell's text starts, as the table draws it (numbers right-aligned). */
export function textStart(rect: { x: number; width: number }, width: number, align: "left" | "right", pad: number): number {
  return align === "right" ? rect.x + rect.width - pad - width : rect.x + pad;
}

/** A selection of [start, end) in a cell, or of the whole cell (age, triple-click); undefined for an empty cell. Pure. */
export function selectIn(row: RowData, columns: ColumnInfo[], col: number, range: [number, number] | "all"): TextSel | undefined {
  const c = columns[col];
  const text = row.cells[col] ?? "";
  if (!c || !text) return undefined;
  if (c.type === "age") return { key: row.key, column: c.name, text, start: 0, end: Number.MAX_SAFE_INTEGER, age: true };
  const [start, end] = range === "all" ? [0, text.length] : range;
  if (start >= end) return undefined;
  return { key: row.key, column: c.name, text, start, end };
}

/** Whether sel still holds for the row as shown: same object, column present, unchanged text. Pure. */
export function current(sel: TextSel | undefined, row: RowData | undefined, columns: ColumnInfo[]): number | undefined {
  if (!sel || !row || row.key !== sel.key) return undefined;
  const i = columns.findIndex((c) => c.name === sel.column);
  return i >= 0 && row.cells[i] === sel.text ? i : undefined;
}

/** What ⌘C copies: the selected part, an age cell's timestamp; undefined when stale. Pure. */
export function selectedText(sel: TextSel | undefined, row: RowData | undefined, columns: ColumnInfo[]): string | undefined {
  if (current(sel, row, columns) === undefined) return undefined;
  return sel!.age ? sel!.text : sel!.text.slice(sel!.start, sel!.end);
}

/** The [start, end) to highlight in the shown text (an age cell's "5m" whole). Pure. */
export function shownRange(sel: TextSel, now: number): [number, number] {
  return sel.age ? [0, formatAge(sel.text, now).length] : [sel.start, sel.end];
}
