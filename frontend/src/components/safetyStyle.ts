import type { SafetyRule } from "../transport/types";

/**
 * CSS color for a rule: a theme token name ("prod") maps to its variable;
 * anything else is a literal color from config.yaml (validated by Go).
 */
export function ruleColor(r: SafetyRule | undefined): string | undefined {
  if (!r?.color) return undefined;
  return /^[a-z][a-z0-9-]*$/.test(r.color) ? `var(--color-${r.color})` : r.color;
}
