/**
 * Live grep: what the field applies while typing. Positive terms only
 * narrow as they grow, so they apply at once; a negated term does the
 * opposite (`!c` hides nearly everything, `!co`, `!com` … bring rows back),
 * and so does an alternative (`a | r` shows nearly everything, `a | ru` …
 * hides rows again), so the one still being typed waits until it's
 * finished: a space after it, ⏎, or leaving the field. Syntax: see
 * internal/pipeline/grep.go.
 */
export interface LiveGrep {
  /** The value to apply now. */
  apply: string;
  /** Start of the held-back term (or its `|`) in the text, or -1. */
  pendingFrom: number;
}

export function liveGrep(text: string): LiveGrep {
  // where the terms start, tracking quotes and escapes like the Go parser
  const starts = [0];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (c === " " && !quoted) starts.push(i + 1);
  }
  const start = starts[starts.length - 1]!;
  // the last term is finished (a space follows), or narrows as it grows: all applies
  if (start === text.length) return { apply: text, pendingFrom: -1 };
  // an alternative: held back from its "|" (the term before it, maybe empty
  // tokens of repeated spaces between)
  let bar = -1;
  for (let k = starts.length - 2; k >= 0; k--) {
    const tok = text.slice(starts[k], starts[k + 1]! - 1);
    if (tok === "") continue;
    if (tok === "|") bar = starts[k]!;
    break;
  }
  if (bar >= 0) return { apply: text.slice(0, bar).trimEnd(), pendingFrom: bar };
  if (!text.startsWith("!", start)) return { apply: text, pendingFrom: -1 };
  return { apply: text.slice(0, start).trimEnd(), pendingFrom: start };
}

export interface GrepTerm {
  text: string;
  not: boolean;
  /** Anchored to the start of a cell (`^x`). */
  prefix?: boolean;
  /** Anchored to the end of a cell (`x$`). */
  suffix?: boolean;
  /** Joined to the previous term (`a | b`): one of the group has to hold. */
  or?: boolean;
}

/**
 * The terms of a grep stage, parsed like ParseGrep in internal/pipeline/grep.go
 * (keep the two in sync): space-separated, `!x` negates, `^x`/`x$` anchor to
 * a cell's start/end, a lone `|` ORs its neighbours, `"a b"` is one term, a
 * backslash escapes the next character. Lower-cased; empty terms dropped.
 */
export function parseGrep(s: string): GrepTerm[] {
  const terms: GrepTerm[] = [];
  let cur = "";
  let not = false, prefix = false, dollar = false, quoted = false, started = false, or = false;
  const flush = () => {
    const text = dollar ? cur.slice(0, -1) : cur;
    if (text) {
      const t: GrepTerm = { text: text.toLowerCase(), not };
      if (prefix) t.prefix = true;
      if (dollar) t.suffix = true;
      if (or && terms.length) t.or = true;
      terms.push(t);
      or = false;
    }
    cur = "";
    not = prefix = dollar = started = false;
  };
  const rs = [...s];
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]!;
    if (r === "\\" && i + 1 < rs.length) {
      cur += rs[++i];
      dollar = false;
      started = true;
    } else if (r === '"') {
      quoted = !quoted;
      started = true;
    } else if (r === " " && !quoted) flush();
    else if (r === "|" && !quoted && !started && (i + 1 === rs.length || rs[i + 1] === " ")) or = true;
    else if (r === "!" && !started) not = started = true;
    else if (r === "^" && !prefix && !cur) prefix = started = true;
    else {
      cur += r;
      dollar = r === "$";
      started = true;
    }
  }
  flush();
  return terms;
}

/**
 * Whether cells (a row's, or a log line's parts) satisfy the terms, like
 * MatchGrep in internal/pipeline/grep.go: searched in the lower-cased cells
 * joined by a space, so a phrase can span two; anchored terms start or end
 * where a cell does. Consecutive `or` terms form a group, one must hold.
 */
export function matchGrep(terms: GrepTerm[], cells: string[]): boolean {
  if (terms.length === 0) return true;
  const j = joinCells(cells);
  let group = true;
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i]!;
    const ok = occurrences(j, t, true).length > 0 !== t.not;
    group = t.or ? group || ok : ok;
    if (!terms[i + 1]?.or && !group) return false;
  }
  return true;
}

/** A [start, end) range of a cell's text. */
export type Range = [start: number, end: number];

/**
 * Where the positive terms occur, per cell: found like matchGrep, so a phrase
 * across two cells highlights in both and an anchored term only where it's
 * anchored. Overlapping occurrences are merged. Negated terms never occur in
 * a shown row and aren't highlighted.
 */
export function grepRanges(cells: string[], terms: GrepTerm[]): Range[][] {
  const j = joinCells(cells);
  const found = terms.filter((t) => !t.not).flatMap((t) => occurrences(j, t, false));
  found.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return j.lower.map((l, i) => {
    const out: Range[] = [];
    const base = j.starts[i]!, end = j.ends[i]!;
    // lower-casing changed the length (e.g. "İ"): offsets wouldn't map back to the text
    if (l.length === cells[i]!.length) {
      for (const [s, e] of merged) {
        if (e > base && s < end) out.push([Math.max(s, base) - base, Math.min(e, end) - base]);
      }
    }
    return out;
  });
}

interface Joined {
  lower: string[];
  row: string;
  starts: number[];
  ends: number[];
}

function joinCells(cells: string[]): Joined {
  const lower = cells.map((c) => c.toLowerCase());
  const starts: number[] = [], ends: number[] = [];
  let at = 0;
  for (const l of lower) {
    starts.push(at);
    ends.push(at + l.length);
    at += l.length + 1;
  }
  return { lower, row: lower.join(" "), starts, ends };
}

/** The term's occurrences in the joined row (only the first if first). */
function occurrences(j: Joined, t: GrepTerm, first: boolean): Range[] {
  const out: Range[] = [];
  for (let i = j.row.indexOf(t.text); i >= 0; i = j.row.indexOf(t.text, i + 1)) {
    const e = i + t.text.length;
    if ((t.prefix && !j.starts.includes(i)) || (t.suffix && !j.ends.includes(e))) continue;
    out.push([i, e]);
    if (first) break;
  }
  return out;
}
