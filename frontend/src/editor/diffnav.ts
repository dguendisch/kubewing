/** The change (1-based) a cursor line is on or after, given each change's first line; 0 before the first. Pure. */
export function changeIndex(starts: number[], line: number): number {
  let i = 0;
  while (i < starts.length && starts[i]! <= line) i++;
  return i;
}
