import type { PaneState } from "../store/state";
import type { SafetyRule } from "../transport/types";

/** Tab label: the focused pane's context label (safety rule), resource and namespace. */
export const tabTitle = (p: PaneState | undefined, rule?: SafetyRule) =>
  p ? `${rule?.label ? `${rule.label} · ` : ""}${p.spec.resource}${p.spec.namespace ? ` · ${p.spec.namespace}` : ""}` : "…";
