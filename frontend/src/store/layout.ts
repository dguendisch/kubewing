/** Split layout tree, iTerm-style. Pure functions; see layout.test.ts. */
export type Layout =
  | { type: "pane"; id: string }
  /** sizes: relative weights per child (resized by dragging a divider); absent = equal shares. */
  | { type: "split"; dir: "row" | "column"; children: Layout[]; sizes?: number[] };

export const leaf = (id: string): Layout => ({ type: "pane", id });

export function paneIds(l: Layout): string[] {
  return l.type === "pane" ? [l.id] : l.children.flatMap(paneIds);
}

/** Splits `target` in `dir` ("row" = side by side), inserting `newId` after it. */
export function split(l: Layout, target: string, dir: "row" | "column", newId: string): Layout {
  return insert(l, target, dir === "row" ? "right" : "bottom", newId);
}

/** A side of a pane (or of the whole tab) a pane can be put on. */
export type Side = "left" | "right" | "top" | "bottom";

const sideDir = (side: Side): "row" | "column" => (side === "left" || side === "right" ? "row" : "column");
const sideAfter = (side: Side) => side === "right" || side === "bottom";

/** Puts `newId` on a side of `target`: they share what `target` had, half each. */
export function insert(l: Layout, target: string, side: Side, newId: string): Layout {
  const dir = sideDir(side);
  const at = sideAfter(side) ? 1 : 0;
  if (l.type === "pane") {
    if (l.id !== target) return l;
    return { type: "split", dir, children: at ? [l, leaf(newId)] : [leaf(newId), l] };
  }
  const idx = l.children.findIndex((c) => c.type === "pane" && c.id === target);
  if (idx >= 0 && l.dir === dir) {
    const children = [...l.children];
    children.splice(idx + at, 0, leaf(newId));
    // the target gives half its share to the new one; the others keep theirs
    let sizes = l.sizes;
    if (sizes) {
      sizes = [...sizes];
      const half = sizes[idx]! / 2;
      sizes.splice(idx, 1, half, half);
    }
    return withSizes({ ...l, children }, sizes);
  }
  return { ...l, children: l.children.map((c) => insert(c, target, side, newId)) };
}

/**
 * Puts `newId` along a whole edge of the layout (the tab's): it gets an equal
 * share next to the panes or splits already on that axis, which keep their
 * proportions among themselves.
 */
export function insertEdge(l: Layout, side: Side, newId: string): Layout {
  const dir = sideDir(side);
  const after = sideAfter(side);
  if (l.type === "split" && l.dir === dir) {
    const k = l.children.length;
    const kept = shares(l).map((f) => (f * k) / (k + 1));
    const children = after ? [...l.children, leaf(newId)] : [leaf(newId), ...l.children];
    const sizes = after ? [...kept, 1 / (k + 1)] : [1 / (k + 1), ...kept];
    return withSizes({ ...l, children }, l.sizes ? sizes : undefined);
  }
  return { type: "split", dir, children: after ? [l, leaf(newId)] : [leaf(newId), l] };
}

/** The share of the tab a pane put on its `side` edge gets (see insertEdge). */
export function edgeShare(l: Layout, side: Side): number {
  return l.type === "split" && l.dir === sideDir(side) ? 1 / (l.children.length + 1) : 1 / 2;
}

/** The side of a rectangle a point is nearest to, by its diagonals (as a drop onto a pane picks where it goes). */
export function nearestSide(r: Rect, x: number, y: number): Side {
  const dx = (x - r.x) / r.w - 0.5;
  const dy = (y - r.y) / r.h - 0.5;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "top" : "bottom";
}

/** The part of `r` on its `side`, `f` of its width or height (the drop preview). */
export function sidePart(r: Rect, side: Side, f: number): Rect {
  if (side === "left") return { ...r, w: r.w * f };
  if (side === "right") return { ...r, x: r.x + r.w * (1 - f), w: r.w * f };
  if (side === "top") return { ...r, h: r.h * f };
  return { ...r, y: r.y + r.h * (1 - f), h: r.h * f };
}

/** Removes a pane, collapsing single-child splits. Returns undefined if the tree is empty. */
export function remove(l: Layout, target: string): Layout | undefined {
  if (l.type === "pane") return l.id === target ? undefined : l;
  const kept = l.children.map((c, i) => [remove(c, target), l.sizes?.[i]] as const).filter(([c]) => c !== undefined);
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0]![0];
  // the remaining children keep their relative weights; a child that collapsed
  // into a split with our direction is merged in, so the tree stays canonical
  // (no same-direction nesting: dockview's grid can't express it)
  const children: Layout[] = [];
  const weights: number[] = [];
  const own = l.sizes ? kept.map(([, w]) => w!) : kept.map(() => 1);
  kept.forEach(([c], i) => {
    if (c!.type === "split" && c!.dir === l.dir) {
      shares(c!).forEach((f, j) => {
        children.push(c!.children[j]!);
        weights.push(own[i]! * f);
      });
    } else {
      children.push(c!);
      weights.push(own[i]!);
    }
  });
  const sized = !!l.sizes || kept.some(([c]) => c!.type === "split" && c!.dir === l.dir && !!c!.sizes);
  const merged = children.length !== kept.length;
  return withSizes({ ...l, children }, sized || merged ? weights : undefined);
}

function withSizes(l: Extract<Layout, { type: "split" }>, sizes: number[] | undefined): Layout {
  return sizes ? { ...l, sizes } : { type: l.type, dir: l.dir, children: l.children };
}

/** Same arrangement of the same panes, whatever the sizes (a move that changes nothing). */
export function sameShape(a: Layout, b: Layout): boolean {
  if (a.type === "pane" || b.type === "pane") return a.type === b.type && (a as { id: string }).id === (b as { id: string }).id;
  return a.dir === b.dir && a.children.length === b.children.length && a.children.every((c, i) => sameShape(c, b.children[i]!));
}

/** Child weights of a split, normalized to sum 1 (equal shares without sizes). */
export function shares(l: Extract<Layout, { type: "split" }>): number[] {
  const n = l.children.length;
  const w = l.sizes?.length === n && l.sizes.every((x) => x > 0) ? l.sizes : Array<number>(n).fill(1);
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}

/**
 * Validity: unique pane ids, splits have ≥2 children (and one positive size
 * per child, if sized), and no split directly inside one with the same direction.
 */
export function valid(l: Layout): boolean {
  const ids = paneIds(l);
  if (new Set(ids).size !== ids.length) return false;
  const ok = (n: Layout): boolean =>
    n.type === "pane" ||
    (n.children.length >= 2 &&
      (!n.sizes || (n.sizes.length === n.children.length && n.sizes.every((x) => x > 0))) &&
      n.children.every((c) => c.type === "pane" || c.dir !== n.dir) &&
      n.children.every(ok));
  return ok(l);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalized pane rectangles (unit square), honoring split sizes like the rendering does. */
export function rects(l: Layout, r: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> {
  if (l.type === "pane") return new Map([[l.id, r]]);
  const out = new Map<string, Rect>();
  let at = 0;
  shares(l).forEach((f, i) => {
    const sub =
      l.dir === "row"
        ? { x: r.x + r.w * at, y: r.y, w: r.w * f, h: r.h }
        : { x: r.x, y: r.y + r.h * at, w: r.w, h: r.h * f };
    at += f;
    for (const [id, rr] of rects(l.children[i]!, sub)) out.set(id, rr);
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

/** The window's bottom corners a pane touches: macOS rounds those, so the pane's frame has to follow. */
export function bottomCorners(l: Layout, id: string): { left: boolean; right: boolean } {
  const r = rects(l).get(id);
  if (!r || r.y + r.h < 1 - EPS) return { left: false, right: false };
  return { left: r.x <= EPS, right: r.x + r.w >= 1 - EPS };
}
