/**
 * Line `line` (0-based) of `from` in `to`: the nearest line there with the
 * same text under the same parents (the object changed a bit in between,
 * e.g. its status), else the nearest with the same text, else the same line
 * number (within `to`).
 */
export function sameLine(from: string, line: number, to: string): number {
  const a = from.split("\n");
  const b = to.split("\n");
  if (line >= a.length) return Math.max(0, b.length - 1);
  const want = a[line]!;
  const path = parents(a, line);
  const near = (ok: (i: number) => boolean) => {
    for (let d = 0; d < b.length; d++) {
      if (line - d >= 0 && line - d < b.length && b[line - d] === want && ok(line - d)) return line - d;
      if (line + d < b.length && b[line + d] === want && ok(line + d)) return line + d;
    }
    return -1;
  };
  const i = near((i) => parents(b, i) === path);
  if (i >= 0) return i;
  const j = near(() => true);
  return j >= 0 ? j : Math.min(line, b.length - 1);
}

/** The lines a YAML line is nested in (each one less indented than the last; a list item's "- name: x" too), joined. */
function parents(lines: string[], line: number): string {
  const indent = (s: string) => s.length - s.trimStart().length;
  const out: string[] = [];
  let min = indent(lines[line]!);
  for (let i = line - 1; i >= 0 && min > 0; i--) {
    const s = lines[i]!;
    if (!s.trim() || indent(s) >= min) continue;
    out.push(s);
    min = indent(s);
  }
  return out.join("\n");
}
