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
