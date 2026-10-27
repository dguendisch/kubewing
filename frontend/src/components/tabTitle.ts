import type { PaneState, Tab } from "../store/state";
import type { SafetyRule } from "../transport/types";

/** A pane's title: its context label (safety rule), then its name, else its resource and namespace. */
export const paneTitle = (p: PaneState | undefined, rule?: SafetyRule) =>
  p ? `${rule?.label ? `${rule.label} · ` : ""}${p.name ?? `${p.spec.resource}${p.spec.namespace ? ` · ${p.spec.namespace}` : ""}`}` : "…";

/** Tab label: the tab's name, else the focused pane's title; the context label always leads (prod stays recognizable). */
export const tabTitle = (t: Tab | undefined, p: PaneState | undefined, rule?: SafetyRule) =>
  t?.name ? `${rule?.label ? `${rule.label} · ` : ""}${t.name}` : paneTitle(p, rule);
