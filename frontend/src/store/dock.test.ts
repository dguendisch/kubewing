import { describe, expect, it } from "vitest";
import { fromDockview, groupId, sameLayout, toDockview, type DockLayout } from "./dock";
import { leaf, paneIds, rects, shares, split, valid, type Layout } from "./layout";
import * as S from "./state";

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

describe("toDockview / fromDockview", () => {
  it("a single pane is one group in a root branch", () => {
    const d = toDockview(leaf("v1"), "v1");
    expect(d.grid.root).toEqual({ type: "branch", data: [{ type: "leaf", size: 1000, data: { id: "g-v1", views: ["v1"], activeView: "v1" } }] });
    expect(d.panels).toEqual({ v1: { id: "v1", contentComponent: "pane" } });
    expect(d.activeGroup).toBe(groupId("v1"));
    expect(fromDockview(d)).toEqual(leaf("v1"));
  });

  it("orientation alternates per depth and sizes become weights", () => {
    let l: Layout = leaf("a");
    l = split(l, "a", "row", "b"); // a | b
    l = split(l, "b", "column", "c"); // a | (b / c)
    const d = toDockview(l, "c");
    expect(d.grid.orientation).toBe("HORIZONTAL");
    const root = d.grid.root as Extract<DockLayout["grid"]["root"], { type: "branch" }>;
    expect(root.data.map((n) => n.type)).toEqual(["leaf", "branch"]);
    const back = fromDockview(d)!;
    expect(sameLayout(back, l)).toBe(true);
    expect(paneIds(back)).toEqual(["a", "b", "c"]);
  });

  it("dragged dividers (pixel sizes) come back as normalized weights", () => {
    const l: Layout = { type: "split", dir: "row", children: [leaf("a"), leaf("b"), leaf("c")] };
    const d = toDockview(l, "a");
    const root = d.grid.root as { data: { size?: number }[] };
    [700, 200, 100].forEach((px, i) => (root.data[i]!.size = px));
    const back = fromDockview(d) as Extract<Layout, { type: "split" }>;
    expect(back.sizes).toEqual([0.7, 0.2, 0.1]);
    const b = rects(back).get("b")!; // ⌘⌥-arrows use the real geometry
    expect([b.x, b.w].map((x) => Math.round(x * 100))).toEqual([70, 20]);
  });

  it("sizes are pixels along each branch's own axis", () => {
    // row [a 0.25, column [b 0.6, c 0.4]] in an 800×400 box
    const l: Layout = { type: "split", dir: "row", sizes: [0.25, 0.75], children: [leaf("a"), { type: "split", dir: "column", sizes: [0.6, 0.4], children: [leaf("b"), leaf("c")] }] };
    const d = toDockview(l, "a", { width: 800, height: 400 });
    const root = d.grid.root as { data: { size?: number; data: unknown }[] };
    expect(root.data.map((n) => n.size)).toEqual([200, 600]); // widths
    const col = root.data[1]!.data as { size?: number }[];
    expect(col.map((n) => n.size)).toEqual([240, 160]); // heights of b and c
    expect(sameLayout(fromDockview(d)!, l)).toBe(true);
  });

  it("same-direction nesting is flattened with weights preserved", () => {
    const nested: Layout = {
      type: "split",
      dir: "row",
      children: [leaf("a"), { type: "split", dir: "row", children: [leaf("b"), leaf("c")] }],
    };
    const back = fromDockview(toDockview(nested, "a")) as Extract<Layout, { type: "split" }>;
    expect(paneIds(back)).toEqual(["a", "b", "c"]);
    expect(back.children.every((c) => c.type === "pane")).toBe(true);
    expect(shares(back)).toEqual([0.5, 0.25, 0.25]);
  });

  it("round-trips every layout the store can produce (random ops, random resizes)", () => {
    const rnd = rng(7);
    let s = S.initialState();
    for (let i = 0; i < 2000; i++) {
      const r = rnd();
      if (r < 0.3) s = S.splitPane(s, rnd() < 0.5 ? "row" : "column");
      else if (r < 0.45) s = S.closePane(s);
      else if (r < 0.55) s = S.cyclePane(s, 1);
      else {
        // user drags a divider: random pixel sizes on every branch
        const d = toDockview(S.activeTab(s).layout, S.activeTab(s).focused);
        const jitter = (n: DockLayout["grid"]["root"]) => {
          n.size = 50 + Math.floor(rnd() * 900);
          if (n.type === "branch") n.data.forEach(jitter);
        };
        jitter(d.grid.root);
        s = S.setLayout(s, fromDockview(d)!);
      }
      const t = S.activeTab(s);
      expect(valid(t.layout)).toBe(true);
      expect(paneIds(t.layout)).toContain(t.focused);
      const back = fromDockview(toDockview(t.layout, t.focused))!;
      expect(sameLayout(back, t.layout)).toBe(true);
      expect(paneIds(back)).toEqual(paneIds(t.layout));
    }
  });
});

describe("setLayout", () => {
  it("accepts rearrangements of the same panes only", () => {
    let s = S.splitPane(S.initialState(), "row"); // v1 | v2
    const swapped: Layout = { type: "split", dir: "column", children: [leaf("v2"), leaf("v1")], sizes: [0.3, 0.7] };
    s = S.setLayout(s, swapped);
    expect(S.activeTab(s).layout).toEqual(swapped);
    expect(S.setLayout(s, leaf("v1"))).toBe(s); // dropping a pane: refused
    expect(S.setLayout(s, { type: "split", dir: "row", children: [leaf("v1"), leaf("zz")] })).toBe(s); // unknown pane
    expect(S.setLayout(s, { type: "split", dir: "row", children: [leaf("v1"), leaf("v2")], sizes: [1] })).toBe(s); // invalid sizes
  });

  it("splitting a sized pane halves its share; closing keeps the others' weights", () => {
    let s = S.splitPane(S.initialState(), "row"); // v1 | v2
    s = S.setLayout(s, { type: "split", dir: "row", children: [leaf("v1"), leaf("v2")], sizes: [0.8, 0.2] });
    s = S.focusPane(s, "v1");
    s = S.splitPane(s, "row"); // v1 | v3 | v2
    let l = S.activeTab(s).layout as Extract<Layout, { type: "split" }>;
    expect(paneIds(l)).toEqual(["v1", "v3", "v2"]);
    expect(shares(l).map((x) => Math.round(x * 100))).toEqual([40, 40, 20]);
    s = S.closePane(s, "v3");
    l = S.activeTab(s).layout as Extract<Layout, { type: "split" }>;
    expect(shares(l).map((x) => Math.round(x * 100))).toEqual([67, 33]);
  });
});

describe("remove keeps the tree canonical", () => {
  it("a collapsed child with the parent's direction is merged, weights preserved", () => {
    // row [a, column [b, row [c, d]]] — closing b leaves row [c, d] inside row
    const l: Layout = {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [leaf("a"), { type: "split", dir: "column", children: [leaf("b"), { type: "split", dir: "row", children: [leaf("c"), leaf("d")], sizes: [0.6, 0.4] }] }],
    };
    const r = S.closePane({ ...S.initialState(), tabs: [{ id: "t1", layout: l, focused: "b" }], panes: Object.fromEntries(["a", "b", "c", "d"].map((id) => [id, { id, spec: S.initialSpec(), selected: 0 }])) }, "b");
    const got = S.activeTab(r).layout as Extract<Layout, { type: "split" }>;
    expect(valid(got)).toBe(true);
    expect(paneIds(got)).toEqual(["a", "c", "d"]);
    expect(got.children.every((c) => c.type === "pane")).toBe(true);
    expect(shares(got).map((x) => Math.round(x * 100))).toEqual([50, 30, 20]);
  });
});
