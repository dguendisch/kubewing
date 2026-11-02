/**
 * Completion: pure ranking of candidates for a query. Providers turn
 * catalog data into candidates; the combobox only renders and picks.
 * Reused by the P1 command palette.
 */
import type { ResourceType } from "../transport/types";

export interface Candidate {
  /** Inserted on accept; must resolve on its own (e.g. "machines.cluster.x-k8s.io"). */
  value: string;
  /** Main text shown. */
  label: string;
  /** Secondary text (group, scope, short names). */
  detail?: string;
  /** Alternative spellings that match (short names, singular, kind). */
  aliases?: string[];
  /** Shown but can't be picked; the reason (e.g. "port-forward is TCP only"). */
  disabled?: string;
  /** Can be removed from the list (history): a ✕ (see Combobox onRemove). */
  removable?: boolean;
}

export interface Match {
  candidate: Candidate;
  score: number;
  /** Indexes into label to highlight. */
  hits: number[];
  /** Indexes into detail to highlight (the alias that matched, if shown there). */
  detailHits: number[];
  /** Only a scattered subsequence matched: shown, but not preselected. */
  fuzzy: boolean;
}

// Tiers: exact > prefix > word-start > substring > fuzzy subsequence.
const EXACT = 1000, PREFIX = 800, WORD = 600, SUB = 400, FUZZY = 100;

/** Scores one string; 0 = no match. Shorter targets win ties (closer to what was typed). */
export function score(query: string, target: string): { score: number; hits: number[]; fuzzy?: boolean } {
  const q = query.toLowerCase(), t = target.toLowerCase();
  if (!q) return { score: 1, hits: [] };
  const range = (from: number) => Array.from({ length: q.length }, (_, i) => from + i);
  if (t === q) return { score: EXACT, hits: range(0) };
  const len = Math.min(t.length, 99);
  if (t.startsWith(q)) return { score: PREFIX - len, hits: range(0) };
  const i = t.indexOf(q);
  if (i > 0) {
    const wordStart = /[.\-_/]/.test(t[i - 1]!);
    return { score: (wordStart ? WORD : SUB) - len, hits: range(i) };
  }
  // fuzzy: every query char in order; consecutive and early hits score higher
  const hits: number[] = [];
  let at = 0, bonus = 0;
  for (const ch of q) {
    const j = t.indexOf(ch, at);
    if (j < 0) return { score: 0, hits: [] };
    if (hits.length && j === hits[hits.length - 1]! + 1) bonus += 5;
    hits.push(j);
    at = j + 1;
  }
  return { score: Math.max(1, Math.min(SUB - 100, FUZZY + bonus - hits[0]! - len)), hits, fuzzy: true };
}

/** Ranks candidates by the best of label/aliases; stable for equal scores. */
export function rank(query: string, candidates: Candidate[], limit = 50): Match[] {
  const q = query.trim();
  const out: (Match & { i: number })[] = [];
  candidates.forEach((c, i) => {
    // aliases (short names, singular, kind) can rank higher than the label
    const label = score(q, c.label);
    let best = label, alias: string | undefined;
    for (const a of c.aliases ?? []) {
      const s = score(q, a);
      if (s.score > best.score) [best, alias] = [s, a];
    }
    if (best.score <= 0) return;
    // highlight wherever the match is visible: the label (even as scattered
    // letters) and the alias if the detail shows it (short names)
    const at = alias ? aliasInDetail(c.detail, alias) : -1;
    const detailHits = at < 0 ? [] : best.hits.map((h) => at + h);
    out.push({ candidate: c, score: best.score, hits: label.hits, detailHits, fuzzy: !!best.fuzzy, i });
  });
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.slice(0, limit).map(({ i: _, ...m }) => m);
}

/** Offset of alias as a whole token in detail ("core · namespaced · crd,crds"), or -1. */
function aliasInDetail(detail: string | undefined, alias: string): number {
  let at = 0;
  for (const tok of (detail ?? "").split(/([\s,·]+)/)) {
    if (tok === alias) return at;
    at += tok.length;
  }
  return -1;
}

/**
 * The listing of everything in a namespace (every namespaced type, listed
 * once); offered first, as kubectl's `all` but complete.
 */
export const allCandidate: Candidate = { value: "all", label: "all", detail: "every namespaced type · listed once · needs a namespace", aliases: ["everything"] };

/**
 * Resource type candidates. A plural that exists in several groups (e.g.
 * "machines") completes to its qualified name so the pick resolves uniquely.
 * The listing of everything comes first once there are types to list.
 */
export function resourceCandidates(types: ResourceType[]): Candidate[] {
  const byName = new Map<string, number>();
  for (const t of types) byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
  return [...(types.length ? [allCandidate] : []), ...types.map((t) => {
    const qualified = t.group ? `${t.name}.${t.group}` : t.name;
    const ambiguous = (byName.get(t.name) ?? 0) > 1;
    const short = t.shortNames?.length ? t.shortNames.join(",") : "";
    return {
      value: ambiguous ? qualified : t.name,
      label: ambiguous ? qualified : t.name,
      // a qualified label already shows the group
      detail: [ambiguous ? "" : t.group || "core", t.namespaced ? "namespaced" : "cluster", short].filter(Boolean).join(" · "),
      aliases: [...(t.shortNames ?? []), ...(t.singular ? [t.singular] : []), t.kind, ...(ambiguous ? [] : [qualified])].filter(Boolean),
    };
  })];
}

/** Namespace candidates; "" (all namespaces) comes first so it is never hidden. */
export function namespaceCandidates(namespaces: string[]): Candidate[] {
  return [{ value: "", label: "all namespaces", detail: "*", aliases: ["*"] }, ...namespaces.map((n) => ({ value: n, label: n }))];
}

/** The resource type a typed value refers to, if the catalog knows it unambiguously. */
export function findResource(types: ResourceType[], value: string): ResourceType | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  const hits = types.filter(
    (t) =>
      t.name === v ||
      `${t.name}.${t.group}` === v ||
      t.singular === v ||
      t.kind.toLowerCase() === v ||
      t.shortNames?.includes(v),
  );
  return hits.length === 1 ? hits[0] : undefined;
}
