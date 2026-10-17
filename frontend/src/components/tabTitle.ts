import type { PaneState } from "../store/state";

/** Tab label: the focused pane's resource and namespace. */
export const tabTitle = (p: PaneState | undefined) => (p ? `${p.spec.resource}${p.spec.namespace ? ` · ${p.spec.namespace}` : ""}` : "…");
