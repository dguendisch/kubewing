import { describe, expect, it } from "vitest";
import { bottomCorners, leaf, neighbor, paneIds, rects, split, valid, type Layout } from "./layout";
import * as S from "./state";

const ids = (s: S.UIState) => paneIds(S.activeTab(s).layout);

function invariants(s: S.UIState) {
  expect(s.tabs.length).toBeGreaterThan(0);
  for (const t of s.tabs) {
    expect(valid(t.layout)).toBe(true);
    expect(paneIds(t.layout)).toContain(t.focused); // focus always lands on an existing pane
    for (const id of paneIds(t.layout)) expect(s.panes[id]).toBeDefined();
    // a maximized pane is the focused one, in a tab with others to hide
    if (t.maximized) {
      expect(t.maximized).toBe(t.focused);
      expect(paneIds(t.layout).length).toBeGreaterThan(1);
    }
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
      // jumps: in place (history), into a split, back and forward
      (s) => S.pushHistory(s, S.focusedPane(s).id, `k${s.nextId}`),
      (s) => S.moveHistory(s, S.focusedPane(s).id, "back", `b${s.nextId}`).state,
      (s) => S.moveHistory(s, S.focusedPane(s).id, "forward", `f${s.nextId}`).state,
      (s) => S.splitWith(s, S.jumpSpec(S.focusedPane(s).spec, { resource: "replicasets.apps", namespace: "shop" })),
      (s) => S.toggleMaximize(s),
      (s) => S.toggleMaximize(s),
    );
    let s = S.initialState();
    for (let i = 0; i < 3000; i++) {
      s = apply(s, ops[Math.floor(rnd() * ops.length)]!);
      invariants(s);
      for (const p of Object.values(s.panes)) {
        expect((p.back ?? []).length).toBeLessThanOrEqual(S.historyLimit);
        expect((p.forward ?? []).length).toBeLessThanOrEqual(S.historyLimit);
        expect(p.back?.length !== 0 && p.forward?.length !== 0).toBe(true); // empty is undefined
      }
    }
  });
});

describe("maximize pane (⌘⇧⏎)", () => {
  const max = (s: S.UIState) => S.activeTab(s).maximized;
  const two = () => S.splitPane(S.initialState(), "row"); // v1 | v2, focus v2

  it("toggles the focused pane; the layout and the other panes stay", () => {
    const s = S.toggleMaximize(two());
    expect(max(s)).toBe("v2");
    expect(S.activeTab(s).layout).toEqual(S.activeTab(two()).layout);
    expect(ids(s)).toEqual(["v1", "v2"]);
    expect(max(S.toggleMaximize(s))).toBeUndefined();
  });

  it("a single pane has nothing to maximize", () => {
    const s = S.initialState();
    expect(S.toggleMaximize(s)).toBe(s);
  });

  it("splitting, closing or moving focus shows all panes again", () => {
    const s = S.toggleMaximize(two());
    expect(max(S.splitPane(s, "column"))).toBeUndefined();
    expect(max(S.closePane(s, "v1"))).toBeUndefined(); // closing another one
    expect(max(S.closePane(s))).toBeUndefined();
    expect(max(S.cyclePane(s, 1))).toBeUndefined();
    expect(max(S.focusDirection(s, "left"))).toBeUndefined();
    expect(max(S.focusPane(s, "v1"))).toBeUndefined();
    // focusing the maximized pane itself (a click into it) keeps it
    expect(max(S.focusPane(s, "v2"))).toBe("v2");
    // a terminal opening below it is a split too
    expect(max(S.openTerminal(s, { session: "s1", pod: "p", container: "c", context: "k" }))).toBeUndefined();
  });

  it("is per tab", () => {
    let s = S.toggleMaximize(two());
    s = S.newTab(s);
    expect(max(s)).toBeUndefined();
    s = S.gotoTab(s, 1);
    expect(max(s)).toBe("v2");
  });

  it("survives a rearranged layout of the same panes", () => {
    const s = S.toggleMaximize(two());
    const swapped: Layout = { type: "split", dir: "row", children: [leaf("v2"), leaf("v1")] };
    expect(max(S.setLayout(s, swapped))).toBe("v2");
  });
});

describe("jumps and their history", () => {
  const owner = { resource: "deployments.apps", namespace: "shop", filter: 'o.metadata.name == "web"' };
  const owned = { resource: "replicasets.apps", namespace: "shop" };

  it("a jump replaces the pane's filters with the target's, keeping the context", () => {
    const from: S.PaneSpec = { ...S.initialSpec("kind", ""), grep: "web", filter: "x", labelSelector: "a=b", hideHealthy: true };
    expect(S.jumpSpec(from, owner)).toEqual({ context: "kind", resource: "deployments.apps", namespace: "shop", labelSelector: "", grep: "", filter: 'o.metadata.name == "web"' });
    const node = S.jumpSpec(from, { resource: "pods", fieldSelector: "spec.nodeName=n1" });
    expect(node.fieldSelector).toBe("spec.nodeName=n1");
    expect(S.pipelineYAML(node)).toBe(JSON.stringify({ source: { resource: "pods", cluster: "kind", fieldSelector: "spec.nodeName=n1" } }));
    // a field selector is part of the source: changing it re-subscribes
    expect(S.sameSource(from, { ...from, fieldSelector: "spec.nodeName=n1" })).toBe(false);
    expect(S.sameSource(from, { ...from, fieldSelector: "" })).toBe(true);
  });

  // what the dispatcher does: push, then show the target
  const jump = (s: S.UIState, key: string, t: Parameters<typeof S.jumpSpec>[1]) =>
    S.updatePane(S.pushHistory(s, "v1", key), "v1", (p) => ({ ...p, spec: S.jumpSpec(p.spec, t), selected: 0 }));
  const go = (s: S.UIState, dir: "back" | "forward", key?: string) => {
    const r = S.moveHistory(s, "v1", dir, key);
    return r.entry ? S.updatePane(r.state, "v1", (p) => ({ ...p, spec: r.entry!.spec })) : r.state;
  };
  const where = (s: S.UIState) => s.panes.v1!.spec.resource;

  it("back then forward redoes the jump; each way reselects the row that view had", () => {
    let s = S.initialState("kind", "shop");
    s = jump(s, "uid-pod", owner); // pods → deployment
    expect([where(s), s.panes.v1!.back?.length, s.panes.v1!.forward]).toEqual(["deployments.apps", 1, undefined]);

    s = go(s, "back", "uid-deploy");
    expect([where(s), s.panes.v1!.reselect, s.panes.v1!.back, s.panes.v1!.forward]).toEqual([
      "pods", "uid-pod", undefined, [{ spec: S.jumpSpec(S.initialSpec("kind", "shop"), owner), key: "uid-deploy" }],
    ]);
    s = go(s, "forward", "uid-pod");
    expect([where(s), s.panes.v1!.reselect, s.panes.v1!.forward]).toEqual(["deployments.apps", "uid-deploy", undefined]);
    expect(s.panes.v1!.back).toEqual([{ spec: S.initialSpec("kind", "shop"), key: "uid-pod" }]);
  });

  it("a new jump after going back drops the forward history, as a browser does", () => {
    let s = jump(jump(S.initialState(), "a", owner), "b", owned); // pods → deploy → rs
    s = go(s, "back", "rs-row"); // at deploy, rs forward
    expect(s.panes.v1!.forward).toHaveLength(1);
    s = jump(s, "c", { resource: "pods", namespace: "shop" });
    expect(s.panes.v1!.forward).toBeUndefined();
    expect(s.panes.v1!.back!.map((e) => e.spec.resource)).toEqual(["pods", "deployments.apps"]);
  });

  it("several steps back and forward walk the chain in order", () => {
    let s = jump(jump(S.initialState(), "a", owner), "b", owned);
    s = go(go(s, "back"), "back");
    expect(where(s)).toBe("pods");
    expect(S.moveHistory(s, "v1", "back", undefined).entry).toBeUndefined(); // the start
    s = go(s, "forward");
    expect(where(s)).toBe("deployments.apps");
    s = go(s, "forward");
    expect(where(s)).toBe("replicasets.apps");
    expect(S.moveHistory(s, "v1", "forward", undefined).entry).toBeUndefined(); // the newest
  });

  it("the row to reselect: shown at an index, gone, or a stale answer", () => {
    const { state } = S.moveHistory(jump(S.initialState(), "uid-pod", owner), "v1", "back", undefined);
    const r = S.reselected(state, "v1", "uid-pod", 4);
    expect(r.panes.v1!.selected).toBe(4);
    expect(r.panes.v1!.reselect).toBeUndefined();
    expect(S.reselected(state, "v1", "uid-pod", -1).panes.v1!.selected).toBe(0); // gone meanwhile: stays
    expect(S.reselected(state, "v1", "other", 2)).toBe(state);
  });

  it("⌘O to a new source is a navigation; the same source (filters aside) isn't", () => {
    const s = S.initialState("kind", "shop");
    const at = s.panes.v1!.spec;
    // what the dispatcher does: openHistory, then show the spec
    const open = (x: S.UIState, spec: S.PaneSpec, key?: string) => S.updatePane(S.openHistory(x, "v1", spec, key), "v1", (p) => ({ ...p, spec }));
    // each part of the source counts, the namespace alone too
    for (const spec of [{ ...at, namespace: "" }, { ...at, resource: "deployments" }, { ...at, context: "prod" }, { ...at, labelSelector: "app=web" }]) {
      expect(S.openHistory(s, "v1", spec, "k").panes.v1!.back).toEqual([{ spec: at, key: "k" }]);
    }
    expect(S.openHistory(s, "v1", { ...at }, "k")).toBe(s);
    expect(S.openHistory(s, "v1", { ...at, grep: "web", filter: "true", hideHealthy: true }, "k")).toBe(s);
    expect(S.openHistory(s, "nope", { ...at, namespace: "" }, "k")).toBe(s);

    // jump, back, then ⌘O elsewhere: the forward history goes, back returns to where ⌘O started
    let x = go(jump(s, "uid-pod", owner), "back", "uid-deploy");
    expect(x.panes.v1!.forward).toHaveLength(1);
    x = open(x, { ...at, resource: "services" }, "uid-pod");
    expect([where(x), x.panes.v1!.forward]).toEqual(["services", undefined]);
    x = go(x, "back");
    expect([where(x), x.panes.v1!.reselect]).toEqual(["pods", "uid-pod"]);
  });

  it("several steps at once (a pick from the history list): the views passed over go to the other side, in order", () => {
    let s = jump(jump(jump(S.initialState(), "a", owner), "b", owned), "c", { resource: "services" }); // pods → deploy → rs → services
    const r = S.moveHistory(s, "v1", "back", "svc", 3);
    expect(r.entry).toEqual({ spec: S.initialSpec(), key: "a" });
    s = S.updatePane(r.state, "v1", (p) => ({ ...p, spec: r.entry!.spec }));
    expect([where(s), s.panes.v1!.back, s.panes.v1!.reselect]).toEqual(["pods", undefined, "a"]);
    // forward, nearest last: deploy, rs, then services (with the row it had)
    expect(s.panes.v1!.forward!.map((e) => [e.spec.resource, e.key])).toEqual([["services", "svc"], ["replicasets.apps", "c"], ["deployments.apps", "b"]]);
    // and two forward again: rs, deploy behind it, services still ahead
    s = (({ state, entry }) => S.updatePane(state, "v1", (p) => ({ ...p, spec: entry!.spec })))(S.moveHistory(s, "v1", "forward", "a2", 2));
    expect(where(s)).toBe("replicasets.apps");
    expect(s.panes.v1!.back!.map((e) => [e.spec.resource, e.key])).toEqual([["pods", "a2"], ["deployments.apps", "b"]]);
    expect(s.panes.v1!.forward!.map((e) => e.spec.resource)).toEqual(["services"]);
    // more steps than there are, or none: nowhere
    expect(S.moveHistory(s, "v1", "back", undefined, 3).entry).toBeUndefined();
    expect(S.moveHistory(s, "v1", "back", undefined, 0).entry).toBeUndefined();
  });

  it("nowhere to go: unchanged", () => {
    const s = S.initialState();
    expect(S.moveHistory(s, "v1", "back", "k")).toEqual({ state: s });
    expect(S.moveHistory(s, "v1", "forward", "k")).toEqual({ state: s });
  });

  it("bounded in both directions", () => {
    let s = S.initialState();
    for (let i = 0; i < S.historyLimit + 5; i++) s = S.pushHistory(s, "v1", `k${i}`);
    expect(s.panes.v1!.back).toHaveLength(S.historyLimit);
    expect(s.panes.v1!.back!.at(-1)!.key).toBe(`k${S.historyLimit + 4}`);
    for (let i = 0; i < S.historyLimit + 5; i++) s = S.moveHistory(s, "v1", "back", `f${i}`).state;
    expect(s.panes.v1!.back).toBeUndefined();
    expect(s.panes.v1!.forward).toHaveLength(S.historyLimit);
  });

  it("splits and new tabs start without history; a jump into a split opens below, focused", () => {
    let s = S.pushHistory(S.initialState(), "v1", "k");
    expect(S.splitPane(s, "row").panes.v2!.back).toBeUndefined();
    expect(S.newTab(s).panes.v2!.back).toBeUndefined();
    s = S.splitWith(s, S.jumpSpec(s.panes.v1!.spec, owner));
    const l = S.activeTab(s).layout;
    expect(l.type === "split" && l.dir).toBe("column");
    expect(S.activeTab(s).focused).toBe("v2");
    expect(s.panes.v2!.spec.resource).toBe("deployments.apps");
    expect(s.panes.v2!.back).toBeUndefined();
    expect(s.panes.v1!.back).toHaveLength(1); // the source pane keeps its own
    invariants(s);
  });

  it("the jump menu holds the menu's focus context, Esc restores", () => {
    let s = S.openOverlay(S.initialState(), { kind: "jump", pane: "v1", key: "k", index: 0 });
    expect(s.focus).toBe("menu");
    s = S.closeOverlay(s);
    expect(s.focus).toBe("table");
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
    const y = S.pipelineYAML({ context: "c", resource: "po", namespace: "", labelSelector: "app=x", grep: "oom", filter: "" });
    expect(JSON.parse(y)).toEqual({ source: { cluster: "c", resource: "po", labelSelector: "app=x" }, stages: [{ grep: "oom" }] });
    const f = S.pipelineYAML({ context: "", resource: "po", namespace: "", labelSelector: "", grep: "oom", filter: 'o.status.phase == "Running"' });
    expect(JSON.parse(f).stages).toEqual([{ filter: 'o.status.phase == "Running"' }, { grep: "oom" }]);
    const h = S.pipelineYAML({ context: "", resource: "po", namespace: "", labelSelector: "", grep: "", filter: "", hideHealthy: true });
    expect(JSON.parse(h).stages).toEqual([{ hideHealthy: true }]);
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

  it("a shell that exited closes its pane and releases the session", () => {
    const a = apply(S.initialState(), (x) => S.openTerminal(x, term("s1")));
    const b = apply(a, (x) => S.sessionEnded(x, "s1", "0"));
    expect(ids(b)).toEqual(["v1"]);
    expect(b.focus).toBe("table");
    expect(S.orphanedSessions(a, b)).toEqual(["s1"]);
    // ⌃D after a failed command still ends the shell: once typed into, any status closes the pane
    const typed = apply(a, (x) => S.termTyped(x, "v2"));
    expect(ids(apply(typed, (x) => S.sessionEnded(x, "s1", "2")))).toEqual(["v1"]);
    invariants(b);
  });

  it("a shell that fails before the first keystroke keeps its pane and output", () => {
    const a = apply(S.initialState(), (x) => S.openTerminal(x, term("s1")));
    const b = apply(a, (x) => S.sessionEnded(x, "s1", "127"));
    expect(ids(b)).toEqual(["v1", "v2"]);
    expect(b.panes.v2!.term?.exited).toBe("127");
    expect(S.orphanedSessions(a, b)).toEqual([]);
    expect(S.termTyped(S.termTyped(a, "v2"), "v2").panes.v2!.term?.typed).toBe(true);
    expect(S.termTyped(a, "v1")).toBe(a); // not a terminal
  });

  it("a session that never ran keeps its pane, with the reason", () => {
    const a = apply(S.initialState(), (x) => S.openTerminal(x, term("s1")));
    const b = apply(a, (x) => S.sessionEnded(x, "s1", "container app not found"));
    expect(ids(b)).toEqual(["v1", "v2"]);
    expect(b.panes.v2!.term?.exited).toBe("container app not found");
    expect(S.orphanedSessions(a, b)).toEqual([]);
    expect(S.sessionEnded(b, "gone", "0")).toBe(b); // unknown session
    // the shell is gone, so its keys are the app's again: ⌃D closes the pane
    expect(b.focus).toBe("ended");
    expect(apply(apply(b, (x) => S.cyclePane(x, -1)), (x) => S.cyclePane(x, 1)).focus).toBe("ended");
    invariants(b);
  });

  it("a session ending in a background tab leaves the active tab alone", () => {
    let s = apply(S.initialState(), (x) => S.openTerminal(x, term("s1"))); // t1: v1 | v2(term)
    s = apply(s, S.newTab); // t2 is active
    s = apply(s, (x) => ({ ...x, focus: "filter" as const }));
    const t2 = S.activeTab(s).id;
    const after = apply(s, (x) => S.sessionEnded(x, "s1", "0"));
    expect(S.activeTab(after).id).toBe(t2);
    expect(after.focus).toBe("filter"); // the pane in use keeps focus
    expect(after.tabs[0]!.layout).toEqual({ type: "pane", id: "v1" });
    invariants(after);
  });

  it("the last pane of a background tab closes that tab, keeping the active one", () => {
    let s = apply(S.initialState(), (x) => S.openTerminal(x, term("s1")));
    s = apply(s, (x) => S.closePane(x, "v1")); // t1 holds only the terminal now
    s = apply(apply(s, S.newTab), S.newTab); // t1, t2, t3 (active)
    const t3 = S.activeTab(s).id;
    const after = apply(s, (x) => S.sessionEnded(x, "s1", "0"));
    expect(after.tabs).toHaveLength(2);
    expect(S.activeTab(after).id).toBe(t3);
    invariants(after);
  });
});

describe("contextNamespace", () => {
  const list = { contexts: ["a", "b"], current: "a", namespaces: { a: "shoot--x" } };
  it("uses the namespace the kubeconfig context sets, else all", () => {
    expect(S.contextNamespace(list, "")).toBe("shoot--x"); // "" = current context
    expect(S.contextNamespace(list, "a")).toBe("shoot--x");
    expect(S.contextNamespace(list, "b")).toBe("");
    expect(S.contextNamespace(undefined, "")).toBe("");
  });
  it("seeds the first pane and the defaults for new panes", () => {
    const s = S.initialState("", "shoot--x");
    expect(s.panes.v1!.spec.namespace).toBe("shoot--x");
    expect(s.defaults.namespace).toBe("shoot--x");
  });
});

describe("bottomCorners (macOS rounds the window's bottom corners)", () => {
  // ┌────┬────┐
  // │ v1 │ v2 │
  // │    ├────┤
  // │    │ v3 │
  // └────┴────┘
  const l: Layout = split(split(leaf("v1"), "v1", "row", "v2"), "v2", "column", "v3");

  it("marks only the corners a pane touches", () => {
    expect(bottomCorners(leaf("a"), "a")).toEqual({ left: true, right: true });
    expect(bottomCorners(l, "v1")).toEqual({ left: true, right: false });
    expect(bottomCorners(l, "v2")).toEqual({ left: false, right: false });
    expect(bottomCorners(l, "v3")).toEqual({ left: false, right: true });
    expect(bottomCorners(l, "gone")).toEqual({ left: false, right: false });
  });
});
