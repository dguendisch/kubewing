import type { Candidate } from "../complete/complete";
import type { ColumnOption, ColumnSpec, ColumnType, FieldKeys, MetricsPlace } from "../transport/types";

/** A row of the column dialog: a server column (wide if priority > 0) or a custom one. */
export interface ColumnRow {
  name: string;
  shown: boolean;
  type?: ColumnType;
  priority?: number;
  path?: string;
  expr?: string;
  missing?: boolean;
  /** A metric column's group (see MetricGroup). */
  metric?: MetricGroup;
}

export const isCustom = (r: ColumnRow) => !!(r.path || r.expr);
export const isWide = (r: ColumnRow) => (r.priority ?? 0) > 0;
export const isMetric = (r: ColumnRow) => !!r.metric;

/** The dialog's rows: Go lists the shown columns in order, then the other server columns. */
export function initialColumns(options: ColumnOption[]): ColumnRow[] {
  return options.map((o) => ({ name: o.name, shown: o.shown, type: o.type || undefined, priority: o.priority, path: o.path, expr: o.expr, missing: o.missing, metric: o.metric }));
}

/** The server's defaults again: those shown in order, the other server columns hidden, custom ones dropped. */
export function resetColumns(rows: ColumnRow[], defaults: string[]): ColumnRow[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const shown = defaults.map((name) => ({ ...(byName.get(name) ?? { name }), shown: true }));
  const rest = rows.filter((r) => !isCustom(r) && !r.missing && !defaults.includes(r.name)).map((r) => ({ ...r, shown: false }));
  return [...shown, ...rest];
}

export function toggle(rows: ColumnRow[], i: number): ColumnRow[] {
  return rows.map((r, j) => (j === i ? { ...r, shown: !r.shown } : r));
}

/** -o wide: on when every wide column is shown. */
export function wideOn(rows: ColumnRow[]): boolean {
  const wide = rows.filter(isWide);
  return wide.length > 0 && wide.every((r) => r.shown);
}

/** Shows all wide columns, or hides them all if they all are shown. */
export function toggleWide(rows: ColumnRow[]): ColumnRow[] {
  const on = !wideOn(rows);
  return rows.map((r) => (isWide(r) ? { ...r, shown: on } : r));
}

/** A group of metric columns: usage (kubectl top, m) or a node's requests/limits (⇧M). */
export type MetricGroup = "usage" | "alloc";

const inGroup = (g: MetricGroup) => (r: ColumnRow) => r.metric === g;

/** On when every metric column of the group is shown. */
export function metricsOn(rows: ColumnRow[], group: MetricGroup): boolean {
  const m = rows.filter(inGroup(group));
  return m.length > 0 && m.every((r) => r.shown);
}

/**
 * Shows all metric columns of a group, or hides them all if they all are
 * shown. Hiding returns where they were (the shown column before the first
 * of them, "" = they were first; their order), to be saved. Showing puts
 * them back as placed (the saved place) if the column they followed is
 * still shown, else after the other group's last shown column (requests
 * and limits after usage), else right after NAME, else after the last shown
 * column; in the saved order, the ones it doesn't name after them.
 */
export function toggleMetrics(rows: ColumnRow[], group: MetricGroup, place?: MetricsPlace): { rows: ColumnRow[]; place?: MetricsPlace } {
  const mine = inGroup(group);
  if (metricsOn(rows, group)) {
    const first = rows.findIndex((r) => mine(r) && r.shown);
    const before = rows.slice(0, first).findLast((r) => r.shown && !mine(r));
    const order = rows.filter((r) => mine(r) && r.shown).map((r) => r.name);
    return { rows: rows.map((r) => (mine(r) ? { ...r, shown: false } : r)), place: { after: before?.name ?? "", order } };
  }
  const rest = rows.filter((r) => !mine(r));
  const rank = (r: ColumnRow) => {
    const i = place?.order?.indexOf(r.name) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  // a stable sort: those the saved order doesn't name keep theirs, after it
  const metric = rows
    .filter(mine)
    .map((r) => ({ ...r, shown: true }))
    .sort((a, b) => rank(a) - rank(b));
  const after = place?.after;
  const shownAt = (name: string) => rest.findIndex((r) => r.shown && r.name === name);
  const otherLast = rest.findLastIndex((r) => r.shown && isMetric(r));
  let at: number;
  if (after === "") at = 0;
  else if (after !== undefined && shownAt(after) >= 0) at = shownAt(after) + 1;
  else if (otherLast >= 0) at = otherLast + 1;
  else at = (shownAt("NAME") >= 0 ? shownAt("NAME") : rest.findLastIndex((r) => r.shown)) + 1;
  return { rows: [...rest.slice(0, at), ...metric, ...rest.slice(at)] };
}

/** Moves row i by delta (−1 up, +1 down); at an end it stays. */
export function move(rows: ColumnRow[], i: number, delta: number): ColumnRow[] {
  const j = i + delta;
  if (j < 0 || j >= rows.length) return rows;
  const out = [...rows];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Moves row from to the position of row to (drag & drop: it lands where the target was). */
export function moveTo(rows: ColumnRow[], from: number, to: number): ColumnRow[] {
  if (from === to || !rows[from] || to < 0 || to >= rows.length) return rows;
  const out = [...rows];
  const [r] = out.splice(from, 1);
  out.splice(to, 0, r!);
  return out;
}

/**
 * A header dragged in the table: the shown columns (as the view shows them,
 * custom ones with their spec from the saved columns) with from moved to to.
 * What is saved for the type; null when that's the server's defaults again.
 */
export function moveShown(shown: string[], saved: ColumnSpec[] | undefined, defaults: string[], from: number, to: number): ColumnSpec[] | null | undefined {
  if (from === to || from < 0 || to < 0 || from >= shown.length || to >= shown.length) return undefined;
  const spec = new Map((saved ?? []).map((c) => [c.name.toUpperCase(), c]));
  const rows: ColumnRow[] = shown.map((name) => {
    const c = spec.get(name.toUpperCase());
    return c && (c.path || c.expr) ? { name: c.name, shown: true, path: c.path, expr: c.expr, type: c.type } : { name, shown: true };
  });
  return toConfig(moveTo(rows, from, to), defaults);
}

/** Removes a custom column (server columns are hidden, not removed). */
export function remove(rows: ColumnRow[], i: number): ColumnRow[] {
  return rows[i] && isCustom(rows[i]) ? rows.filter((_, j) => j !== i) : rows;
}

export interface NewColumn {
  name: string;
  mode: "path" | "expr";
  value: string;
  type: ColumnType;
}

export const emptyColumn: NewColumn = { name: "", mode: "path", value: "", type: "" };

/**
 * Adds a custom column, shown, after the last shown one. Its name defaults to
 * the path's last segment, upper-cased. Go compiles it on save.
 */
export function addColumn(rows: ColumnRow[], c: NewColumn): { rows: ColumnRow[] } | { error: string } {
  const value = c.value.trim();
  if (!value) return { error: c.mode === "path" ? "a field path is required, e.g. spec.nodeName" : "a CEL expression is required, e.g. o.spec.nodeName" };
  if (c.mode === "path" && /\s/.test(value)) return { error: "a field path has no spaces; use CEL for keys with dots, e.g. o.metadata.labels[\"app.kubernetes.io/name\"]" };
  const name = (c.name.trim() || defaultName(value)).toUpperCase();
  if (rows.some((r) => r.name.toUpperCase() === name)) return { error: `there is a column ${name} already` };
  const row: ColumnRow = { name, shown: true, type: c.type || undefined, ...(c.mode === "path" ? { path: value } : { expr: value }) };
  const at = rows.findLastIndex((r) => r.shown) + 1;
  return { rows: [...rows.slice(0, at), row, ...rows.slice(at)] };
}

function defaultName(value: string): string {
  const seg = value.split(/[.[\]]/).filter((s) => s && !/^\d+$/.test(s)).pop() ?? value;
  return seg.replace(/[^A-Za-z0-9_-]/g, "") || "COLUMN";
}

/**
 * What is saved: the shown columns in order, server ones by name. When that
 * is exactly the server's defaults, null (follow the server, e.g. new columns
 * after an upgrade).
 */
export function toConfig(rows: ColumnRow[], defaults: string[]): ColumnSpec[] | null {
  const shown = rows.filter((r) => r.shown);
  if (shown.every((r) => !isCustom(r)) && shown.map((r) => r.name).join("\0") === defaults.join("\0")) return null;
  return shown.map((r) => (isCustom(r) ? { name: r.name, ...(r.path ? { path: r.path } : { expr: r.expr }), ...(r.type ? { type: r.type } : {}) } : { name: r.name }));
}

/**
 * A field path being typed, for completion one segment at a time: the
 * complete segments before the last dot (list indices dropped: FieldKeys
 * descends into list items) and the start of the one being typed.
 */
export function pathContext(value: string): { parent: string[]; prefix: string; head: string } {
  const dot = value.lastIndexOf(".");
  const head = dot < 0 ? "" : value.slice(0, dot + 1);
  const parent = head
    .split(".")
    .map((s) => s.replace(/\[\d*\]$/, ""))
    .filter(Boolean);
  return { parent, prefix: value.slice(dot + 1), head };
}

/** Completion candidates for a field path: the keys under its parent, as whole paths; keys with dots need CEL. */
export function pathCandidates(value: string, keys: FieldKeys | undefined): Candidate[] {
  const { head } = pathContext(value);
  return (keys?.keys ?? [])
    .filter((k) => !k.key.includes("."))
    // shown as the key; matched as the whole path, which is what's typed (Combobox ranks the whole value)
    .map((k) => ({ value: head + k.key + (k.type === "map" ? "." : k.type === "list" ? "[0]." : ""), label: k.key, aliases: [head + k.key], detail: `${k.type} · ${k.count}/${keys!.objects}` }));
}
