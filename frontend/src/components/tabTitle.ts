import { clusterLabel, type PaneState, type Tab } from "../store/state";
import type { SafetyRule } from "../transport/types";

/**
 * How a pane names its resource type: the plural ("etcds"), with its group
 * only if the plural exists in several groups ("machines" + ".machine.sapcloud.io").
 * full is the qualified name (for a tooltip). Until the server resolved the
 * type, the spec's resource as given.
 */
export function resourceLabel(p: Pick<PaneState, "spec" | "type" | "ambiguous">): { name: string; group: string; full: string } {
  const full = p.type || p.spec.resource;
  // plurals have no dots: the first segment is the plural, the rest its group
  const dot = p.type ? full.indexOf(".") : -1;
  if (dot < 0) return { name: full, group: "", full };
  return { name: full.slice(0, dot), group: p.ambiguous ? full.slice(dot) : "", full };
}

/**
 * A pane's title: its context label (safety rule), the mark of the Gardener
 * plane it shows (icon: ◉ shoot, ⛭ control plane …), then its name, else its
 * resource and namespace.
 */
export const paneTitle = (p: PaneState | undefined, rule?: SafetyRule, icon = "") => {
  if (!p) return "…";
  const lead = `${rule?.label ? `${rule.label} · ` : ""}${icon ? `${icon} ` : ""}`;
  // ⌘⇧O's pane listing nothing yet: its cluster
  if (!p.spec.resource && !p.term && !p.logs) return `${lead}${p.name ?? (clusterLabel(p.spec.context) || "…")}`;
  const r = resourceLabel(p);
  return `${lead}${p.name ?? `${r.name}${r.group}${p.spec.namespace ? ` · ${p.spec.namespace}` : ""}`}`;
};

/** Tab label: the tab's name, else the focused pane's title; the context label always leads (prod stays recognizable), the plane's mark next. */
export const tabTitle = (t: Tab | undefined, p: PaneState | undefined, rule?: SafetyRule, icon = "") =>
  t?.name ? `${rule?.label ? `${rule.label} · ` : ""}${icon ? `${icon} ` : ""}${t.name}` : paneTitle(p, rule, icon);
