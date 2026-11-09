import type { Candidate } from "../complete/complete";
import type { MetaChanges } from "../transport/types";

/** One change of the label / annotate dialog, as the preview lists it. */
export interface MetaChange {
  key: string;
  op: "add" | "change" | "remove" | "same";
  value?: string;
  /** change, remove, same: the value now. */
  old?: string;
}

/**
 * The label / annotate dialog's text, as kubectl takes it: `key=value`
 * sets, `key-` removes, separated by spaces or new lines. Annotation values
 * may contain spaces when quoted (`note="two words"`); label values can't
 * (Go rejects them). Each change is compared with the current keys: setting
 * a key to its value is "same", removing an absent key is an error. Pure.
 */
export function parseMeta(text: string, current: Record<string, string> = {}): { changes: MetaChange[]; send: MetaChanges } | { error: string } {
  const tokens = splitTokens(text);
  if ("error" in tokens) return tokens;
  const changes: MetaChange[] = [];
  const seen = new Set<string>();
  for (const t of tokens.list) {
    const eq = t.indexOf("=");
    let key: string;
    let change: MetaChange;
    if (eq >= 0) {
      key = t.slice(0, eq);
      const value = t.slice(eq + 1);
      const old = current[key];
      change = { key, value, op: old === undefined ? "add" : old === value ? "same" : "change", old };
    } else if (t.endsWith("-")) {
      key = t.slice(0, -1);
      if (!(key in current)) return { error: `"${key}" isn't set` };
      change = { key, op: "remove", old: current[key] };
    } else {
      return { error: `"${t}": key=value sets, key- removes` };
    }
    if (!key) return { error: `"${t}": the key is missing` };
    if (seen.has(key)) return { error: `"${key}" is given twice` };
    seen.add(key);
    changes.push(change);
  }
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const c of changes) {
    if (c.op === "remove") remove.push(c.key);
    else if (c.op !== "same") set[c.key] = c.value!;
  }
  return { changes, send: { set, remove } };
}

/** Whitespace-separated tokens; "…" or '…' quote a stretch (kubectl's shell quoting, simplified). */
function splitTokens(text: string): { list: string[] } | { error: string } {
  const list: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) list.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return { error: `unterminated ${quote}` };
  if (has) list.push(cur);
  return { list };
}

/** What a set of changes sends: nothing (only "same" or no text) can't be submitted. */
export function hasChanges(m: MetaChanges): boolean {
  return Object.keys(m.set ?? {}).length + (m.remove?.length ?? 0) > 0;
}

/** The replicas field: a whole number, 0 or more. Pure. */
export function parseReplicas(text: string): { replicas: number } | { error: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { error: t ? `"${t}" isn't a number of replicas (0 or more)` : "how many replicas?" };
  return { replicas: Number(t) };
}

/** A key of the marked rows' labels or annotations: on how many of them, with which values (most common first). */
export interface UnionKey {
  key: string;
  count: number;
  values: { value: string; count: number }[];
}

/** The keys of many rows' labels or annotations, by key. Pure. */
export function unionMeta(maps: (Record<string, string> | undefined)[]): UnionKey[] {
  const by = new Map<string, Map<string, number>>();
  for (const m of maps) {
    for (const [k, v] of Object.entries(m ?? {})) {
      const vs = by.get(k) ?? new Map<string, number>();
      vs.set(v, (vs.get(v) ?? 0) + 1);
      by.set(k, vs);
    }
  }
  return [...by.entries()]
    .map(([key, vs]) => ({
      key,
      count: [...vs.values()].reduce((a, b) => a + b, 0),
      values: [...vs.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The current keys the dialog compares changes with, for many rows: a key
 * with one value on every row is that value (setting it again is "same");
 * one that differs, or isn't on every row, is a value no text equals, so
 * setting it is a change and removing it is allowed. Pure.
 */
export function unionCurrent(keys: UnionKey[], rows: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) out[k.key] = k.count === rows && k.values.length === 1 ? k.values[0]!.value : "\u0000mixed";
  return out;
}

/** The token of the label / annotate text at the caret: what a recent pair replaces (from–to) and what's typed of it (word). */
export function tokenAt(text: string, caret: number): { from: number; to: number; word: string } {
  let start = -1;
  let quote: string | undefined;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === undefined) return { from: start, to: i, word: text.slice(start, caret) };
      continue;
    }
    const space = ch === undefined || /\s/.test(ch);
    if (!space && start < 0) start = i;
    if (!space && (ch === '"' || ch === "'")) quote = ch;
    if (space && start >= 0) {
      if (start <= caret && caret <= i) return { from: start, to: i, word: text.slice(start, caret) };
      start = -1;
    }
    if (i >= caret && start < 0) break;
  }
  return { from: caret, to: caret, word: "" };
}

/** A value as the field takes it back: quoted if it has spaces or quotes (in the kind of quote it doesn't contain). */
export function quoteValue(v: string): string {
  if (!/[\s"']/.test(v)) return v;
  return v.includes('"') ? `'${v}'` : `"${v}"`;
}

/**
 * The recently applied pairs (key=value, newest first) as candidates for the
 * token at the caret: inserted quoted as the field takes them, without keys
 * the rest of the text already gives (they'd be given twice); the detail says
 * how it compares with the current value. Pure.
 */
export function recentCandidates(recent: string[], text: string, at: { from: number; to: number }, current: Record<string, string> = {}): Candidate[] {
  const rest = splitTokens(text.slice(0, at.from) + " " + text.slice(at.to));
  const given = new Set("list" in rest ? rest.list.map((t) => (t.includes("=") ? t.slice(0, t.indexOf("=")) : t.replace(/-$/, ""))) : []);
  return recent.flatMap((pair) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) return [];
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (given.has(key)) return [];
    const old = current[key];
    const detail = old === undefined ? undefined : old === value ? "already set" : old === "\u0000mixed" ? "now differs" : `now ${old}`;
    return [{ value: `${key}=${quoteValue(value)}`, label: pair, detail, removable: true }];
  });
}
