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

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalized pane rectangles (unit square), matching the equal-share flex rendering. */
export function rects(l: Layout, r: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> {
  if (l.type === "pane") return new Map([[l.id, r]]);
  const out = new Map<string, Rect>();
  const n = l.children.length;
  l.children.forEach((c, i) => {
    const sub =
      l.dir === "row"
        ? { x: r.x + (r.w * i) / n, y: r.y, w: r.w / n, h: r.h }
        : { x: r.x, y: r.y + (r.h * i) / n, w: r.w, h: r.h / n };
    for (const [id, rr] of rects(c, sub)) out.set(id, rr);
  });
  return out;
}

export type Direction = "left" | "right" | "up" | "down";

const EPS = 1e-9;

/**
 * The pane next to `from` in a direction (iTerm ⌘⌥arrows): it must lie beyond
 * the edge and overlap on the other axis; most overlap wins, then the nearest.
 * Undefined at the edge (no wrap-around).
 */
export function neighbor(l: Layout, from: string, dir: Direction): string | undefined {
  const all = rects(l);
  const a = all.get(from);
  if (!a) return undefined;
  const horizontal = dir === "left" || dir === "right";
  let best: { id: string; overlap: number; dist: number } | undefined;
  for (const [id, b] of all) {
    if (id === from) continue;
    const dist =
      dir === "left" ? a.x - (b.x + b.w) : dir === "right" ? b.x - (a.x + a.w) : dir === "up" ? a.y - (b.y + b.h) : b.y - (a.y + a.h);
    if (dist < -EPS) continue; // not beyond that edge
    const overlap = horizontal
      ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (overlap <= EPS) continue;
    if (!best || dist < best.dist - EPS || (Math.abs(dist - best.dist) <= EPS && overlap > best.overlap + EPS)) {
      best = { id, overlap, dist };
    }
  }
  return best?.id;
}
