import type { Layout } from "./layout";
import { shares } from "./layout";

/**
 * Pure converters between the store's split tree (the source of truth) and
 * dockview's serialized layout. One dockview group per pane, panel id = pane
 * id, group id = "g-" + pane id. Typed structurally so this file stays
 * free of dockview imports (unit-tested in node).
 */

type Orientation = "HORIZONTAL" | "VERTICAL";

interface GridLeaf {
  type: "leaf";
  data: { id: string; views: string[]; activeView?: string };
  size?: number;
}
interface GridBranch {
  type: "branch";
  data: GridNode[];
  size?: number;
}
type GridNode = GridLeaf | GridBranch;

export interface DockLayout {
  grid: { root: GridNode; width: number; height: number; orientation: Orientation };
  panels: Record<string, { id: string; contentComponent: string; title?: string }>;
  activeGroup?: string;
}

const orient = (dir: "row" | "column"): Orientation => (dir === "row" ? "HORIZONTAL" : "VERTICAL");
const flip = (o: Orientation): Orientation => (o === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL");
export const groupId = (pane: string) => `g-${pane}`;

/**
 * Store layout → dockview layout (component "pane" renders every panel).
 * dockview sizes are pixels: a child's size is its extent along its parent
 * branch's axis, so shares are turned into pixels of the real box.
 */
export function toDockview(l: Layout, focused: string, box = { width: 1000, height: 1000 }): DockLayout {
  const panels: DockLayout["panels"] = {};
  const leaf = (id: string, size?: number): GridLeaf => {
    panels[id] = { id, contentComponent: "pane" };
    return { type: "leaf", data: { id: groupId(id), views: [id], activeView: id }, size };
  };
  // A branch with orientation o lays its children out along o (HORIZONTAL =
  // side by side, along the width) and holds children of orientation flip(o).
  // A child split with the parent's direction is merged into the parent
  // (valid() store trees have none; safety net).
  const node = (n: Layout, o: Orientation, w: number, h: number, size?: number): GridNode => {
    if (n.type === "pane") return leaf(n.id, size);
    const kids: { n: Layout; f: number }[] = [];
    const add = (c: Layout, f: number) => {
      if (c.type === "split" && orient(c.dir) === o) shares(c).forEach((g, i) => add(c.children[i]!, f * g));
      else kids.push({ n: c, f });
    };
    shares(n).forEach((f, i) => add(n.children[i]!, f));
    const along = o === "HORIZONTAL" ? w : h;
    return {
      type: "branch",
      size,
      data: kids.map((k) => {
        const px = k.f * along;
        return o === "HORIZONTAL" ? node(k.n, flip(o), px, h, px) : node(k.n, flip(o), w, px, px);
      }),
    };
  };

  const rootO: Orientation = l.type === "split" ? orient(l.dir) : "HORIZONTAL";
  const root: GridNode =
    l.type === "pane" ? { type: "branch", data: [leaf(l.id, box.width)] } : node(l, rootO, box.width, box.height);
  return { grid: { root, width: box.width, height: box.height, orientation: rootO }, panels, activeGroup: groupId(focused) };
}

/**
 * dockview layout → store layout. Sizes become weights; single-child
 * branches collapse. Returns undefined for an empty grid.
 */
export function fromDockview(d: DockLayout): Layout | undefined {
  const walk = (n: GridNode, o: Orientation): { layout: Layout; size: number } | undefined => {
    const size = n.size ?? 1;
    if (n.type === "leaf") {
      const id = n.data.activeView ?? n.data.views[0];
      return id ? { layout: { type: "pane", id }, size } : undefined;
    }
    const kids = n.data.map((c) => walk(c, flip(o))).filter((x) => x !== undefined);
    if (kids.length === 0) return undefined;
    if (kids.length === 1) return { layout: kids[0]!.layout, size };
    const dir = o === "HORIZONTAL" ? "row" : "column";
    // a nested split with this direction (can't come from dockview's grid, but keep the tree canonical)
    const children: Layout[] = [];
    const sizes: number[] = [];
    for (const k of kids) {
      if (k.layout.type === "split" && k.layout.dir === dir) {
        shares(k.layout).forEach((f, i) => {
          children.push((k.layout as Extract<Layout, { type: "split" }>).children[i]!);
          sizes.push(k.size * f);
        });
      } else {
        children.push(k.layout);
        sizes.push(k.size);
      }
    }
    return { layout: { type: "split", dir, children, sizes: normalize(sizes) }, size };
  };
  return walk(d.grid.root, d.grid.orientation)?.layout;
}

/** Weights rounded to 4 decimals of their share, so tiny pixel jitter doesn't churn the store. */
function normalize(w: number[]): number[] {
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => Math.round((x / sum) * 1e4) / 1e4);
}

/** Layout equality ignoring size noise below 0.5% (pixel rounding in dockview). */
export function sameLayout(a: Layout, b: Layout): boolean {
  if (a.type === "pane" || b.type === "pane") return a.type === b.type && (a as { id: string }).id === (b as { id: string }).id;
  if (a.dir !== b.dir || a.children.length !== b.children.length) return false;
  const sa = shares(a);
  const sb = shares(b);
  return a.children.every((c, i) => Math.abs(sa[i]! - sb[i]!) < 0.005 && sameLayout(c, b.children[i]!));
}
