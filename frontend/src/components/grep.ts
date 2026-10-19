/**
 * Live grep: what the field applies while typing. Positive terms only
 * narrow as they grow, so they apply at once; a negated term does the
 * opposite (`!c` hides nearly everything, `!co`, `!com` … bring rows back),
 * so the one still being typed waits until it's finished: a space after
 * it, ⏎, or leaving the field. Syntax: see internal/pipeline/grep.go.
 */
export interface LiveGrep {
  /** The value to apply now. */
  apply: string;
  /** Start of the held-back negated term in the text, or -1. */
  pendingFrom: number;
}

export function liveGrep(text: string): LiveGrep {
  // where the last term starts, tracking quotes and escapes like the Go parser
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (c === " " && !quoted) start = i + 1;
  }
  // the last term is finished (a space follows) or not negated: all applies
  if (!text.startsWith("!", start)) return { apply: text, pendingFrom: -1 };
  return { apply: text.slice(0, start).trimEnd(), pendingFrom: start };
}
