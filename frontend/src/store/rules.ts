import { create } from "zustand";
import type { SafetyRule } from "../transport/types";

/**
 * Safety rules per resolved context, for display only (badges, colors).
 * Go makes every decision again in Prepare; this cache can't allow anything.
 */
export const useRules = create<Record<string, SafetyRule>>(() => ({}));

/** Fetches the rule for a context unless cached; cleared on config reload. */
export function loadRule(context: string, fetch: (c: string) => Promise<SafetyRule>) {
  if (!context || useRules.getState()[context]) return;
  fetch(context).then((r) => useRules.setState({ [context]: r }), () => {});
}

export const clearRules = () => useRules.setState(() => ({}), true);
