import type { SafetyRule } from "../transport/types";
import { ruleColor } from "./safetyStyle";

/**
 * A safety rule's label (PROD, LIVE) as a chip: the plane badge's look (a
 * light tint of the rule's color, a sharp border in it, its text in it), but
 * square, so the two read apart side by side.
 */
export function SafetyLabel({ rule, named = true }: { rule?: SafetyRule; named?: boolean }) {
  if (!rule?.label) return null;
  const color = ruleColor(rule) ?? "var(--color-accent)";
  return (
    <span
      // named on its own (pane header, lists); in a heading its text is part of the heading's name
      aria-label={named ? "context label" : undefined}
      title={`safety rule for ${rule.context}${rule.readOnly ? ": read-only" : ""}`}
      className="shrink-0 border px-1.5 leading-4 font-semibold"
      style={{ color, borderColor: color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
    >
      {rule.label}
    </span>
  );
}
