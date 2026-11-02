/**
 * ⌘P: the clusters dialog's list, pure (unit-tested). What's typed ranks the
 * recent clusters and gardens (complete.ts rank); a text gardenctl's patterns
 * match (a dashboard URL …) adds its targets on top, a path a kubeconfig file.
 */
import { rank, type Candidate } from "../complete/complete";
import type { ClusterEntry, ClusterList } from "../transport/types";

export interface Item {
  entry: ClusterEntry;
  label: string;
  detail: string;
  /** Indexes into label to highlight. */
  hits: number[];
}

/** What an entry is called in the list: a shoot (or its control plane), a project, a garden, a context. */
export function entryLabel(e: ClusterEntry): string {
  if (!e.garden) return e.context || "(current context)";
  if (e.shoot) return `${e.shoot}${e.controlPlane ? " · control plane" : ""}`;
  if (e.project || e.namespace) return `project ${projectOf(e)}`;
  return e.garden;
}

const projectOf = (e: ClusterEntry) => e.project || (e.namespace === "garden" ? "garden" : e.namespace?.replace(/^garden-/, "")) || "";

/** The line's details: project and garden of a target, its kubeconfig file, when it was used. */
export function entryDetail(e: ClusterEntry, now: Date): string {
  const parts: string[] = [];
  if (e.garden) {
    if (e.shoot && projectOf(e)) parts.push(projectOf(e));
    if (e.shoot || e.project || e.namespace) parts.push(e.garden);
    else parts.push("garden");
  } else {
    parts.push(e.kubeconfig?.length ? e.kubeconfig.map(shortPath).join(", ") : "kubeconfig");
  }
  if (e.from === "gardenctl") parts.push("gardenctl");
  const ago = since(e.used, now);
  if (ago) parts.push(ago);
  return parts.join(" · ");
}

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+\//, "~/").replace(/^\/home\/[^/]+\//, "~/");

/** "5m ago", "3h ago", "2d ago"; "" for the zero time (gardens, matches). */
export function since(used: string, now: Date): string {
  const t = Date.parse(used);
  if (!t || t <= 0 || new Date(t).getUTCFullYear() < 2000) return "";
  const s = Math.max(0, (now.getTime() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The words an entry is found by: shoot, project, garden (and its alias), context, files. */
function aliases(e: ClusterEntry): string[] {
  const out = [e.name, e.context, e.shoot, e.project, e.namespace, e.garden, projectOf(e), ...(e.kubeconfig ?? [])];
  if (e.shoot) out.push(`shoot--${projectOf(e)}--${e.shoot}`);
  return out.filter((x): x is string => !!x);
}

/** A typed text that names a kubeconfig file. */
export const isPath = (text: string) => /^(~\/|\/|\.\.?\/)/.test(text.trim());

/** A ClusterEntry for a typed kubeconfig path (at its current context). */
export function pathEntry(text: string): ClusterEntry {
  return { kubeconfig: [text.trim()], used: "", from: "match", rule: { context: "", confirm: [] } };
}

/**
 * The dialog's list for a text: pattern matches first (they are what was
 * pasted), then a kubeconfig path, then recent clusters and gardens ranked
 * by the text (all of them, recent first, when it's empty).
 */
export function items(list: ClusterList | undefined, matches: ClusterEntry[], text: string, now: Date, limit = 100): Item[] {
  const out: Item[] = [];
  const q = text.trim();
  for (const m of matches) out.push({ entry: m, label: entryLabel(m), detail: entryDetail(m, now), hits: [] });
  if (isPath(q)) {
    const e = pathEntry(q);
    out.push({ entry: e, label: `kubeconfig ${q}`, detail: "its current context", hits: [] });
  }
  // a pasted URL ranks nothing else (its letters would match everything fuzzily)
  if (matches.length && /[/:]/.test(q)) return out;
  if (isPath(q)) return out;
  const all = [...(list?.recent ?? []), ...(list?.gardens ?? [])];
  const cands: (Candidate & { i: number })[] = all.map((e, i) => ({
    value: String(i),
    label: entryLabel(e),
    detail: entryDetail(e, now),
    aliases: aliases(e),
    i,
  }));
  for (const m of rank(q, cands, limit)) {
    const e = all[Number(m.candidate.value)]!;
    out.push({ entry: e, label: m.candidate.label, detail: m.candidate.detail ?? "", hits: m.hits });
  }
  return out.slice(0, limit);
}

/** The highlight after the list changed: kept on the same entry if it's still there, else the first pickable one. */
export function keepIndex(prev: Item | undefined, next: Item[]): number {
  if (prev) {
    const i = next.findIndex((x) => sameEntry(x.entry, prev.entry));
    if (i >= 0) return i;
  }
  const i = next.findIndex((x) => !x.entry.disabled);
  return Math.max(0, i);
}

export function sameEntry(a: ClusterEntry, b: ClusterEntry): boolean {
  return (
    a.from === b.from &&
    (a.garden ?? "") === (b.garden ?? "") &&
    (a.project ?? "") === (b.project ?? "") &&
    (a.namespace ?? "") === (b.namespace ?? "") &&
    (a.shoot ?? "") === (b.shoot ?? "") &&
    !!a.controlPlane === !!b.controlPlane &&
    (a.context ?? "") === (b.context ?? "") &&
    (a.kubeconfig ?? []).join("\n") === (b.kubeconfig ?? []).join("\n")
  );
}
