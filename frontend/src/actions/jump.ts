import { create } from "zustand";
import type { OwnedScan, Relation, Relations } from "../transport/types";

/**
 * The jump menu (⌘J): where a row leads, as Go computed it (see
 * internal/relations). Each entry carries a pipeline target; the dispatcher
 * applies it in place (Esc goes back) or in a split (⇧⏎).
 */
export interface JumpItem {
  id: string;
  section: Relation["section"];
  label: string;
  /** Right-aligned: owner depth, count, "scan…". */
  detail?: string;
  /** Why it can't be jumped to; undefined = it can. */
  disabled?: string;
  /** Muted remark that doesn't block the jump (not checked, not counted). */
  note?: string;
  target?: Relation["target"];
  /** The "scan for owned…" entry: ⏎ runs the owned scan instead of jumping. */
  scan?: boolean;
  /** An owner further up the chain (indented). */
  indent?: number;
}

export const sectionTitle: Record<Relation["section"], string> = { namespace: "namespace", owner: "owners", owned: "owned", events: "events" };

/** State of the open jump menu (read by the dispatcher for ⏎ / j / k). */
export interface JumpState {
  rel?: Relations;
  items: JumpItem[];
  /** The owned scan: running, its result, or what went wrong. */
  scanning?: boolean;
  scanned?: OwnedScan;
  scanError?: string;
  /** A cluster-scoped owner's scan asks once before it lists everything. */
  scanAsked?: boolean;
  /** Runs (or asks for) the scan; set by the open menu. */
  scan?: () => void;
}

export const useJump = create<JumpState>(() => ({ items: [] }));

export const jumpable = (i: JumpItem) => !i.disabled;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Menu rows for a row's relations, plus the owned scan's state. Pure.
 * Owned entries list the known kinds; the scan entry is replaced by what
 * the scan found (kinds already listed aren't repeated).
 */
export function jumpItems(rel: Relations, scan: Pick<JumpState, "scanning" | "scanned" | "scanError" | "scanAsked"> = {}): JumpItem[] {
  const out: JumpItem[] = [];
  const events: JumpItem[] = [];
  for (const r of rel.items) {
    const it: JumpItem = { id: r.id, section: r.section, label: r.label, target: r.target, note: r.note };
    if (r.section === "owner") {
      it.indent = (r.depth ?? 1) - 1;
      if (r.controller) it.detail = "controller";
    }
    if (r.count !== undefined) it.detail = String(r.count);
    if (r.gone) it.disabled = r.gone;
    else if (!r.target) it.disabled = "nowhere to go";
    // no events yet is still worth watching
    else if (r.count === 0 && r.section !== "events") it.disabled = "none";
    (r.section === "events" ? events : out).push(it);
  }
  // sections in a fixed order (namespace, owners, owned): the placeholder goes after the namespace entries
  if (!rel.items.some((r) => r.section === "owner")) {
    const at = out.findIndex((i) => i.section === "owned");
    out.splice(at < 0 ? out.length : at, 0, { id: "owner:none", section: "owner", label: "no owner", disabled: "no ownerReferences" });
  }

  if (rel.scan) {
    if (scan.scanned) {
      // kinds the known entries already cover aren't repeated
      const known = new Set(rel.items.filter((r) => r.section === "owned" && r.target).map((r) => r.kind ?? r.target!.resource));
      for (const r of scan.scanned.items) {
        if (known.has(r.kind ?? r.target?.resource ?? "")) continue;
        out.push({ id: r.id, section: "owned", label: r.label, detail: String(r.count ?? 0), target: r.target });
      }
      const summary = `scanned ${plural(scan.scanned.scanned, "type")}${scan.scanned.skipped ? `, ${scan.scanned.skipped} skipped (${scan.scanned.skipReason})` : ""}`;
      out.push({ id: "scan:done", section: "owned", label: scan.scanned.items.length ? "scan done" : "nothing else owned", disabled: summary });
    } else if (scan.scanning) {
      out.push({ id: "scan", section: "owned", label: "scanning all types…", disabled: "scanning" });
    } else {
      const ask = rel.scanAll && !scan.scanAsked;
      out.push({
        id: "scan",
        section: "owned",
        label: scan.scanAsked ? "scan all namespaces and cluster types — ⏎ again" : "scan for owned…",
        detail: rel.scanAll ? "all namespaces" : rel.namespace ? `in ${rel.namespace}` : undefined,
        note: scan.scanError ?? (ask ? "lists every type in every namespace" : undefined),
        scan: true,
      });
    }
  } else if (!out.some((i) => i.section === "owned")) {
    out.push({ id: "owned:none", section: "owned", label: "nothing known", disabled: "no uid to look for" });
  }
  // after the owned scan's entries
  return [...out, ...events];
}

/** The first entry that can be run (the highlight's start), or 0. */
export function firstJumpable(items: JumpItem[]): number {
  const i = items.findIndex((x) => jumpable(x) && !x.scan && x.section !== "namespace");
  if (i >= 0) return i;
  const j = items.findIndex(jumpable);
  return j >= 0 ? j : 0;
}
