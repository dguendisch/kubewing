/**
 * The lines of a that differ from b (0-based, inclusive), and b's text for
 * them: a whole-text edit kept to what changed, so the cursor and the rest
 * of the undo history stay where they are.
 */
export function changedRange(a: string, b: string): { from: number; to: number; text: string } {
  const al = a.split("\n");
  const bl = b.split("\n");
  let from = 0;
  while (from < al.length - 1 && from < bl.length - 1 && al[from] === bl[from]) from++;
  let ea = al.length - 1;
  let eb = bl.length - 1;
  while (ea > from && eb > from && al[ea] === bl[eb]) {
    ea--;
    eb--;
  }
  return { from, to: ea, text: bl.slice(from, eb + 1).join("\n") };
}
