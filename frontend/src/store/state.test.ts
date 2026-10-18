import { describe, expect, it } from "vitest";
import { leaf, neighbor, paneIds, rects, split, valid, type Layout } from "./layout";
import * as S from "./state";

const ids = (s: S.UIState) => paneIds(S.activeTab(s).layout);

function invariants(s: S.UIState) {
  expect(s.tabs.length).toBeGreaterThan(0);
  for (const t of s.tabs) {
    expect(valid(t.layout)).toBe(true);
    expect(paneIds(t.layout)).toContain(t.focused); // focus always lands on an existing pane
    for (const id of paneIds(t.layout)) expect(s.panes[id]).toBeDefined();
  }
  // the pane area's focus context matches the focused pane's kind
  if (s.focus === "table" || s.focus === "terminal") expect(s.focus).toBe(S.focusedPane(s).term ? "terminal" : "table");
  const all = s.tabs.flatMap((t) => paneIds(t.layout)).sort();
  expect(Object.keys(s.panes).sort()).toEqual(all); // no leaked panes
  expect([...s.mru].sort()).toEqual(s.tabs.map((t) => t.id).sort()); // mru = exactly the open tabs
  if (!s.switcher) expect(s.mru[0]).toBe(S.activeTab(s).id);
  else expect(s.switcher.index).toBeLessThan(s.mru.length);
}

// what setUI does: every update is normalized by touchTab and paneFocus
const apply = (s: S.UIState, f: (s: S.UIState) => S.UIState) => S.paneFocus(S.touchTab(f(s)));

describe("layout commands", () => {
  it("split right then down, iTerm semantics", () => {
    let s = S.initialState("kind");
    s = S.splitPane(s, "row");
    expect(ids(s)).toEqual(["v1", "v2"]);
    expect(S.activeTab(s).focused).toBe("v2");
    s = S.splitPane(s, "column");
    const l = S.activeTab(s).layout;
    expect(l.type === "split" && l.dir).toBe("row");
    expect(ids(s)).toEqual(["v1", "v2", "v3"]);
    expect(s.panes.v3!.spec.context).toBe("kind"); // clone of focused
    invariants(s);
  });

  it("closing panes collapses splits and moves focus", () => {
    let s = S.splitPane(S.splitPane(S.initialState(), "row"), "row");
    s = apply(s, S.closePane);
    expect(ids(s)).toEqual(["v1", "v2"]);
    expect(S.activeTab(s).focused).toBe("v2");
    s = apply(apply(s, S.closePane), S.closePane);
    invariants(s); // replaced by a fresh tab
    expect(ids(s)).toHaveLength(1);
  });

  it("random command sequences keep invariants", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const ops = [
      (s: S.UIState) => S.splitPane(s, "row"),
      (s: S.UIState) => S.splitPane(s, "column"),
      (s: S.UIState) => S.closePane(s),
      (s: S.UIState) => S.newTab(s),
      (s: S.UIState) => S.closeTab(s),
      (s: S.UIState) => S.cycleTab(s, 1),
      (s: S.UIState) => S.cyclePane(s, -1),
    ];
    ops.push(
      (s) => S.switcherStep(s, 1),
      (s) => S.switcherStep(s, -1),
      (s) => S.switcherCommit(s),
      (s) => S.switcherCancel(s),
      (s) => S.focusDirection(s, (["left", "right", "up", "down"] as const)[Math.floor(rnd() * 4)]!),
      (s) => S.gotoTab(s, 1 + Math.floor(rnd() * 9)),
      (s) => S.openTerminal(s, { session: `sx${s.nextId}`, pod: "p", container: "c", context: "k" }),
    );
    let s = S.initialState();
    for (let i = 0; i < 3000; i++) {
      s = apply(s, ops[Math.floor(rnd() * ops.length)]!);
      invariants(s);
    }
  });
});

describe("overlays", () => {
  it("restores previous focus on close", () => {
    let s: S.UIState = { ...S.initialState(), focus: "filter" };
    s = S.openOverlay(s, { kind: "detail", pane: "v1", key: "k" });
    expect(s.focus).toBe("detail");
    s = S.closeOverlay(s);
    expect(s.focus).toBe("filter");
    expect(s.overlay).toBeUndefined();
  });
});

describe("server pane lifetime", () => {
  const attach = (s: S.UIState, id: string, serverId: string) => S.updatePane(s, id, (p) => ({ ...p, serverId }));

  it("switching tabs and splitting keep server panes; closing releases them", () => {
    let s = attach(S.initialState(), "v1", "p1");
    let next = S.newTab(s);
    expect(S.orphanedServerPanes(s, next)).toEqual([]);
    s = attach(next, "v2", "p2");
    next = S.cycleTab(s, 1);
    expect(S.orphanedServerPanes(s, next)).toEqual([]);
    s = next;
    next = S.splitPane(s, "row");
    expect(S.orphanedServerPanes(s, next)).toEqual([]);
    s = next;
    next = S.closeTab(s, 0);
    expect(S.orphanedServerPanes(s, next)).toEqual(["p1"]);
  });

  it("a server pane shared by two UI panes is released with the last one", () => {
    let s = attach(S.splitPane(attach(S.initialState(), "v1", "p1"), "row"), "v2", "p1");
    let next = S.closePane(s);
    expect(S.orphanedServerPanes(s, next)).toEqual([]);
    s = next;
    next = S.updatePane(s, "v1", (p) => ({ ...p, serverId: undefined })); // source replaced
    expect(S.orphanedServerPanes(s, next)).toEqual(["p1"]);
  });
});

describe("pipelineYAML", () => {
  it("serializes the pane spec", () => {
    const y = S.pipelineYAML({ context: "c", resource: "po", namespace: "", labelSelector: "app=x", grep: "oom" });
    expect(JSON.parse(y)).toEqual({ source: { cluster: "c", resource: "po", labelSelector: "app=x" }, stages: [{ grep: "oom" }] });
  });
});

describe("directional pane focus (⌘⌥arrows)", () => {
  // ┌────┬────┐
  // │ v1 │ v2 │
  // │    ├────┤
  // │    │ v3 │
  // └────┴────┘
  const l: Layout = split(split(leaf("v1"), "v1", "row", "v2"), "v2", "column", "v3");

  it("computes equal-share rects", () => {
    expect(rects(l).get("v3")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
  it("moves to the adjacent pane and stops at edges", () => {
    expect(neighbor(l, "v1", "right")).toBe("v2"); // both overlap; equal distance, equal overlap → first
    expect(neighbor(l, "v3", "left")).toBe("v1");
    expect(neighbor(l, "v2", "down")).toBe("v3");
    expect(neighbor(l, "v3", "up")).toBe("v2");
    expect(neighbor(l, "v1", "left")).toBeUndefined();
    expect(neighbor(l, "v2", "up")).toBeUndefined();
    expect(neighbor(l, "v1", "up")).toBeUndefined();
  });
  it("prefers the nearest, then the most overlap", () => {
    // a | b | c side by side, d under all three
    const wide: Layout = { type: "split", dir: "column", children: [{ type: "split", dir: "row", children: [leaf("a"), leaf("b"), leaf("c")] }, leaf("d")] };
    expect(neighbor(wide, "c", "left")).toBe("b"); // a is further away
    expect(neighbor(wide, "d", "up")).toBe("a");
    expect(neighbor(wide, "b", "down")).toBe("d");
  });
  it("focusDirection updates focus or leaves state untouched", () => {
    let s = S.splitPane(S.initialState(), "row"); // v1 | v2, focus v2
    s = S.focusDirection(s, "left");
    expect(S.activeTab(s).focused).toBe("v1");
    expect(S.focusDirection(s, "left")).toBe(s);
  });
});

describe("MRU tab switching (⌃⇥)", () => {
  // three tabs t1, t2, t3; t3 active → mru [t3, t2, t1]
  const three = () => [S.newTab, S.newTab].reduce(apply, S.initialState());
  const activeId = (s: S.UIState) => S.activeTab(s).id;

  it("records use order", () => {
    expect(three().mru).toEqual(["t3", "t2", "t1"]);
  });
  it("quick ⌃⇥ toggles between the two most recent tabs", () => {
    let s = three();
    s = apply(apply(s, (x) => S.switcherStep(x, 1)), S.switcherCommit);
    expect(activeId(s)).toBe("t2");
    expect(s.mru).toEqual(["t2", "t3", "t1"]);
    s = apply(apply(s, (x) => S.switcherStep(x, 1)), S.switcherCommit);
    expect(activeId(s)).toBe("t3");
  });
  it("holding ⌃ and pressing ⇥ again goes further back; browsing doesn't reorder", () => {
    let s = apply(three(), (x) => S.switcherStep(x, 1));
    s = apply(s, (x) => S.switcherStep(x, 1));
    expect(s.switcher?.index).toBe(2);
    expect(activeId(s)).toBe("t3"); // nothing activated while browsing
    expect(s.mru).toEqual(["t3", "t2", "t1"]);
    expect(s.focus).toBe("switcher");
    s = apply(s, S.switcherCommit);
    expect(activeId(s)).toBe("t1");
    expect(s.mru).toEqual(["t1", "t3", "t2"]);
    expect(s.focus).toBe("table");
  });
  it("⌃⇧⇥ starts at the least recent tab and wraps", () => {
    let s = apply(three(), (x) => S.switcherStep(x, -1));
    expect(s.mru[s.switcher!.index]).toBe("t1");
    s = apply(s, (x) => S.switcherStep(x, 1));
    expect(s.switcher!.index).toBe(0); // wrapped to current
  });
  it("esc cancels and restores focus", () => {
    let s: S.UIState = { ...three(), focus: "filter" };
    s = apply(apply(s, (x) => S.switcherStep(x, 1)), S.switcherCancel);
    expect(activeId(s)).toBe("t3");
    expect(s.focus).toBe("filter");
    expect(s.switcher).toBeUndefined();
  });
  it("closing a tab mid-switch ends the switcher", () => {
    let s = apply(three(), (x) => S.switcherStep(x, -1)); // index 2
    s = apply(s, (x) => S.closeTab(x, 0));
    expect(s.switcher).toBeUndefined();
    expect(s.focus).not.toBe("switcher");
  });
  it("no-op with a single tab", () => {
    const s = S.initialState();
    expect(S.switcherStep(s, 1)).toBe(s);
  });
  it("closing a tab drops it from mru; clicking a tab counts as use", () => {
    let s = apply(three(), (x) => S.closeTab(x, 1)); // close t2
    expect(s.mru).not.toContain("t2");
    s = apply(s, (x) => ({ ...x, activeTab: 0 }));
    expect(s.mru[0]).toBe("t1");
  });
});

describe("⌘1–⌘9 tab shortcuts", () => {
  const tabs = (n: number) => Array.from({ length: n - 1 }).reduce<S.UIState>((s) => apply(s, S.newTab), S.initialState());

  it("⌘N goes to tab N, ⌘9 to the last tab, out of range is a no-op", () => {
    let s = tabs(3);
    s = apply(s, (x) => S.gotoTab(x, 1));
    expect(s.activeTab).toBe(0);
    expect(s.mru[0]).toBe("t1"); // counts as use for ⌃⇥
    expect(apply(s, (x) => S.gotoTab(x, 9)).activeTab).toBe(2);
    expect(S.gotoTab(s, 5)).toBe(s);
    const twelve = tabs(12);
    expect(apply(twelve, (x) => S.gotoTab(x, 8)).activeTab).toBe(7);
    expect(apply(twelve, (x) => S.gotoTab(x, 9)).activeTab).toBe(11);
  });
  it("labels: 1–8 for the first tabs, 9 only on the last; beyond that none", () => {
    expect([0, 1, 2].map((i) => S.tabShortcut(i, 3))).toEqual([1, 2, 3]);
    // 9 tabs: the 9th is both "9th" and "last"
    expect(S.tabShortcut(8, 9)).toBe(9);
    // 12 tabs: 9th–11th unreachable, the last gets ⌘9
    expect([7, 8, 9, 10, 11].map((i) => S.tabShortcut(i, 12))).toEqual([8, undefined, undefined, undefined, 9]);
  });
  it("closes the switcher and overlays", () => {
    let s = apply(tabs(3), (x) => S.switcherStep(x, 1));
    s = apply(s, (x) => S.gotoTab(x, 1));
    expect(s.switcher).toBeUndefined();
    expect(s.focus).toBe("table");
  });
});

describe("terminal panes", () => {
  const term = (id: string): S.Term => ({ session: id, pod: "web-0", container: "app", context: "kind" });

  it("open below the source pane with terminal focus; focus follows the pane kind", () => {
    let s = S.initialState();
    s = apply(s, (x) => S.openTerminal(x, term("s1")));
    const t = S.activeTab(s);
    expect(t.layout).toEqual({ type: "split", dir: "column", children: [{ type: "pane", id: "v1" }, { type: "pane", id: "v2" }] });
    expect(t.focused).toBe("v2");
    expect(s.focus).toBe("terminal");
    expect(s.panes.v2!.term?.session).toBe("s1");
    s = apply(s, (x) => S.cyclePane(x, -1));
    expect(s.focus).toBe("table");
    s = apply(s, (x) => S.cyclePane(x, 1));
    expect(s.focus).toBe("terminal");
    // an overlay opened from a terminal restores terminal focus
    s = apply(s, (x) => S.openOverlay(x, { kind: "forwards", pane: "v2" }));
    expect(s.focus).toBe("forwards");
    s = apply(s, S.closeOverlay);
    expect(s.focus).toBe("terminal");
  });

  it("splitting a terminal pane opens a table, not a second view of the session", () => {
    let s = apply(S.initialState(), (x) => S.openTerminal(x, term("s1")));
    s = apply(s, (x) => S.splitPane(x, "row"));
    expect(S.focusedPane(s).term).toBeUndefined();
    expect(s.focus).toBe("table");
  });

  it("sessions are released when no pane references them", () => {
    const a = apply(S.initialState(), (x) => S.openTerminal(x, term("s1")));
    const b = apply(a, (x) => S.closePane(x));
    expect(S.orphanedSessions(a, b)).toEqual(["s1"]);
    const c = apply(a, S.newTab);
    expect(S.orphanedSessions(a, c)).toEqual([]);
    expect(S.orphanedSessions(c, apply(c, (x) => S.closeTab(x, 0)))).toEqual(["s1"]);
  });
});
