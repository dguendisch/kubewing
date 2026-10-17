/** Split layout tree, iTerm-style. Pure functions; see layout.test.ts. */
export type Layout =
  | { type: "pane"; id: string }
  | { type: "split"; dir: "row" | "column"; children: Layout[] };

export const leaf = (id: string): Layout => ({ type: "pane", id });

export function paneIds(l: Layout): string[] {
  return l.type === "pane" ? [l.id] : l.children.flatMap(paneIds);
}

/** Splits `target` in `dir` ("row" = side by side), inserting `newId` after it. */
export function split(l: Layout, target: string, dir: "row" | "column", newId: string): Layout {
  if (l.type === "pane") {
    return l.id === target ? { type: "split", dir, children: [l, leaf(newId)] } : l;
  }
  const idx = l.children.findIndex((c) => c.type === "pane" && c.id === target);
  if (idx >= 0 && l.dir === dir) {
    const children = [...l.children];
    children.splice(idx + 1, 0, leaf(newId));
    return { ...l, children };
  }
  return { ...l, children: l.children.map((c) => split(c, target, dir, newId)) };
}

/** Removes a pane, collapsing single-child splits. Returns undefined if the tree is empty. */
export function remove(l: Layout, target: string): Layout | undefined {
  if (l.type === "pane") return l.id === target ? undefined : l;
  const children = l.children.map((c) => remove(c, target)).filter((c): c is Layout => c !== undefined);
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return { ...l, children };
}

/** Validity: unique pane ids, splits have ≥2 children. */
export function valid(l: Layout): boolean {
  const ids = paneIds(l);
  if (new Set(ids).size !== ids.length) return false;
  const ok = (n: Layout): boolean => n.type === "pane" || (n.children.length >= 2 && n.children.every(ok));
  return ok(l);
}
