import type { PaneSpec } from "../store/state";

/**
 * A history entry in a line: what it shows (the context only when it's not
 * the pane's current one), and its filters apart.
 */
export function describeView(spec: PaneSpec, context?: string): { label: string; detail: string } {
  const where = spec.namespace ? `-n ${spec.namespace}` : "-A";
  const label = `${spec.context && spec.context !== context ? `${spec.context} · ` : ""}${spec.resource} ${where}`;
  const detail = [spec.labelSelector && `-l ${spec.labelSelector}`, spec.fieldSelector, spec.grep && `/${spec.grep}`, spec.filter, spec.hideHealthy && "unhealthy"]
    .filter(Boolean)
    .join(" · ");
  return { label, detail };
}
