import { create } from "zustand";
import type { SafetyRule } from "../transport/types";
import { ruleContext, type PaneState } from "./state";

/**
 * Safety rules per pane cluster and context, for display only (badges,
 * colors). Go makes every decision again in Prepare; this cache can't allow
 * anything. Keyed by the cluster too: a Gardener cluster's landscape (which
 * rules also match) comes from it, not from every context name (gardenctl's
 * shoot--p--s).
 */
export const useRules = create<Record<string, SafetyRule>>(() => ({}));

/** A pane's key into useRules ("" = no context known yet). */
export const ruleKey = (p: PaneState | undefined) => {
  const ctx = ruleContext(p);
  return ctx && p ? `${p.spec.context}\u0000${ctx}` : "";
};

/** Fetches a pane's rule unless cached; cleared on config reload. */
export function loadRule(p: PaneState | undefined, fetch: (cluster: string, context: string) => Promise<SafetyRule>) {
  const key = ruleKey(p);
  if (!p || !key || useRules.getState()[key]) return;
  fetch(p.spec.context, ruleContext(p)).then((r) => useRules.setState({ [key]: r }), () => {});
}

export const clearRules = () => useRules.setState(() => ({}), true);
