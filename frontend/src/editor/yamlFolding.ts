/** A foldable block: 1-based, inclusive lines (Monaco's FoldingRange). */
export interface FoldRange {
  start: number;
  end: number;
}

const itemRe = /^-(\s|$)/;
const keyRe = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#].*?):(?:\s+(.*))?$/;
const blockRe = /^[|>][-+0-9]*\s*(#.*)?$/;

/**
 * Folding ranges of block YAML, for Monaco's folding and sticky scroll.
 * Monaco's fallback folds by indentation alone, which misses that a list may
 * sit at its key's own column (sigs.k8s.io/yaml, kubectl: "containers:" then
 * "- args:" at the same indent): such a key folds nothing and never sticks.
 * Here a key without an inline value spans the lines deeper than it plus the
 * "- " items at its column; a list item spans the lines deeper than its dash;
 * a block scalar (| or >) spans its text, which isn't parsed. Comments and
 * blank lines end nothing (trailing ones aren't included). Sorted by start,
 * one range per line (the widest: "- args:" opens an item and a key). Pure.
 */
export function yamlFoldingRanges(lines: string[]): FoldRange[] {
  // open nodes; key: children deeper than col or "- " at col; item, text: deeper than col
  type Frame = { start: number; col: number; kind: "key" | "item" | "text" };
  const stack: Frame[] = [];
  const ends = new Map<number, number>();
  let last = -1; // last content line so far (0-based)
  const close = (f: Frame) => {
    if (last > f.start) ends.set(f.start + 1, Math.max(ends.get(f.start + 1) ?? 0, last + 1));
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const text = raw.trimStart();
    if (!text) continue;
    let col = raw.length - text.length;
    const top = stack[stack.length - 1];
    if (top?.kind === "text" && col > top.col) {
      last = i;
      continue;
    }
    if (text.startsWith("#")) continue;
    let rest = text;
    const item = itemRe.test(rest);
    while (stack.length) {
      const f = stack[stack.length - 1]!;
      if (col > f.col || (item && f.kind === "key" && col === f.col)) break;
      close(f);
      stack.pop();
    }
    last = i;
    // each "- " opens a list item; its node starts after the dash and spaces
    let dash = col;
    while (itemRe.test(rest)) {
      stack.push({ start: i, col, kind: "item" });
      dash = col;
      const after = rest.slice(1).trimStart();
      col += rest.length - after.length;
      rest = after;
    }
    if (blockRe.test(rest)) {
      stack.push({ start: i, col: dash, kind: "text" });
      continue;
    }
    const kv = rest.match(keyRe);
    if (!kv) continue;
    const v = kv[2] ?? "";
    if (v === "" || v.startsWith("#")) stack.push({ start: i, col, kind: "key" });
    else if (blockRe.test(v)) stack.push({ start: i, col, kind: "text" });
  }
  while (stack.length) close(stack.pop()!);
  return [...ends].map(([start, end]) => ({ start, end })).sort((a, b) => a.start - b.start);
}
