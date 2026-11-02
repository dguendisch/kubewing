import { describe, expect, it } from "vitest";
import { bottomCorners, edgeShare, insert, insertEdge, leaf, nearestSide, neighbor, paneIds, rects, sidePart, split, valid, type Layout } from "./layout";
import * as S from "./state";
import { paneTitle, resourceLabel, tabTitle } from "../components/tabTitle";

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
      // drag and drop: any pane to any side of any pane or tab edge, or a new tab
      (s) => {
        const all = Object.keys(s.panes);
        const pick = <T,>(l: T[]) => l[Math.floor(rnd() * l.length)]!;
        const t = pick(s.tabs);
        const side = pick(["left", "right", "top", "bottom"] as const);
        const to: S.MoveTarget = rnd() < 0.15 ? { newTab: true } : rnd() < 0.3 ? { tab: t.id, side } : { tab: t.id, pane: pick(paneIds(t.layout)), side };
        return S.movePane(s, pick(all), to);
      },
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
    expect(S.jumpSpec(from, owner)).toEqual({ context: "kind", resource: "deployments.apps", namespace: "shop", labelSelector: "", grep: "", filter: 'o.metadata.name == "web"', jumpFilter: 'o.metadata.name == "web"' });
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

  it("⌘O starts without a jump's field selector (the dialog has no field for it), everything else kept", () => {
    const events = { ...S.initialSpec("kind", "shop"), resource: "events", fieldSelector: "involvedObject.kind=Pod,involvedObject.name=web", grep: "x" };
    const start = S.openSpec(events);
    expect(start).toEqual({ ...S.initialSpec("kind", "shop"), resource: "events", grep: "x" });
    expect("fieldSelector" in start).toBe(false);
    // ⌘O ⏎ on the same resource then drops it too: a new source, so a step back to the events
    expect(S.sameSource(events, start)).toBe(false);
  });

  it("⌘O starts without a jump's CEL filter, but keeps one typed since", () => {
    const ns = S.jumpSpec(S.initialSpec("kind", "shop"), { resource: "namespaces", filter: 'o.metadata.name == "shop"' });
    expect(S.openSpec(ns)).toEqual({ ...S.initialSpec("kind", ""), resource: "namespaces" });
    // typed over it (c ⏎, = in the YAML): the user's, kept
    const typed = { ...ns, filter: "o.status.phase == \"Active\"" };
    expect(S.openSpec(typed).filter).toBe('o.status.phase == "Active"');
    // a filter without a jump: kept
    expect(S.openSpec({ ...S.initialSpec(), filter: "true" }).filter).toBe("true");
    // "pods in shop" carries the pane's own filter: still the user's, kept
    const all: S.PaneSpec = { ...S.initialSpec("kind", ""), filter: "mine" };
    expect(S.openSpec(S.jumpSpec(all, { resource: "pods", namespace: "shop", filter: "mine" })).filter).toBe("mine");
    // … and a jump's filter carried that way is still the jump's
    const owned = S.jumpSpec(all, { resource: "pods", filter: "o.metadata.ownerReferences.exists(r, r.uid == \"u\")" });
    expect(S.openSpec(S.jumpSpec(owned, { resource: "pods", namespace: "shop", filter: owned.filter })).filter).toBe("");
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
  it("a menu's highlight wraps around, skipping what can't be picked", () => {
    const items = [{ ok: true }, { ok: false }, { ok: true }, { ok: false }];
    const ok = (i: { ok: boolean }) => i.ok;
    expect(S.wrapIndex(items, 0, 1, ok)).toBe(2);
    expect(S.wrapIndex(items, 2, 1, ok)).toBe(0); // ↓ on the last pickable: the first
    expect(S.wrapIndex(items, 0, -1, ok)).toBe(2); // ↑ on the first: the last pickable
    expect(S.wrapIndex([{ ok: true }], 0, 1, ok)).toBe(0);
    expect(S.wrapIndex([{ ok: false }], 0, 1, ok)).toBeUndefined();
    expect(S.wrapIndex([], 0, 1, ok)).toBeUndefined();
  });

  it("restores previous focus on close", () => {
    let s: S.UIState = { ...S.initialState(), focus: "filter" };
    s = S.openOverlay(s, { kind: "help", pane: "v1" });
    expect(s.focus).toBe("help");
    s = S.closeOverlay(s);
    expect(s.focus).toBe("filter");
    expect(s.overlay).toBeUndefined();
  });
});

describe("naming tabs and panes", () => {
  const spec = (resource: string, namespace = "") => ({ ...S.initialSpec(), resource, namespace });
  const pane = (p: Partial<S.PaneState> = {}): S.PaneState => ({ id: "v1", spec: spec("pods", "shop"), selected: 0, ...p });

  it("names are trimmed; an empty one removes it", () => {
    let s = S.nameTab(S.initialState(), "t1", "  prod issue ");
    expect(S.activeTab(s).name).toBe("prod issue");
    s = S.nameTab(s, "t1", "  ");
    expect("name" in S.activeTab(s)).toBe(false);
    s = S.namePane(s, "v1", "web");
    expect(s.panes.v1!.name).toBe("web");
    s = S.namePane(s, "v1", "");
    expect("name" in s.panes.v1!).toBe(false);
  });

  it("the field is an overlay in dialog focus; Esc's focus comes back; a pane's moves the focus to it", () => {
    let s = apply(S.initialState(), (x) => S.splitPane(x, "row"));
    s = apply(s, S.renameTab);
    expect(s.overlay).toMatchObject({ kind: "renameTab", tabId: "t1" });
    expect(s.focus).toBe("dialog");
    s = apply(s, S.closeOverlay);
    expect(s.focus).toBe("table");
    s = apply(s, (x) => S.renamePane(x, "v1"));
    expect(s.overlay).toMatchObject({ kind: "renamePane", pane: "v1" });
    expect(S.activeTab(s).focused).toBe("v1");
    invariants(s);
  });

  it("closing the pane or tab being named closes its field", () => {
    let s = apply(S.initialState(), (x) => S.splitPane(x, "row"));
    s = apply(s, (x) => S.renamePane(x, "v2"));
    s = apply(s, (x) => S.closePane(x, "v2"));
    expect(s.overlay).toBeUndefined();
    s = apply(s, S.newTab);
    s = apply(s, (x) => S.renameTab(x, "t1"));
    s = apply(s, (x) => S.closeTab(x, 0));
    expect(s.overlay).toBeUndefined();
    invariants(s);
  });

  it("splits and new tabs don't take the name along", () => {
    let s = S.namePane(S.nameTab(S.initialState(), "t1", "mine"), "v1", "web");
    s = apply(s, (x) => S.splitPane(x, "row"));
    expect(s.panes.v2!.name).toBeUndefined();
    s = apply(s, S.newTab);
    expect(S.activeTab(s).name).toBeUndefined();
  });

  it("titles: the tab's name, else the focused pane's, else its source; the context label leads", () => {
    const rule = { label: "PROD" } as Parameters<typeof tabTitle>[2];
    expect(tabTitle({ id: "t1", layout: leaf("v1"), focused: "v1" }, pane())).toBe("pods · shop");
    expect(tabTitle({ id: "t1", layout: leaf("v1"), focused: "v1" }, pane({ name: "web" }), rule)).toBe("PROD · web");
    expect(tabTitle({ id: "t1", layout: leaf("v1"), focused: "v1", name: "incident" }, pane({ name: "web" }), rule)).toBe("PROD · incident");
    expect(paneTitle(pane({ name: "web" }))).toBe("web");
  });

  it("the resource shows as its plural, qualified only where the plural is ambiguous; the full name for hover", () => {
    // ⌘O's "etcds" and a jump's "etcds.druid.gardener.cloud" look the same once resolved
    expect(resourceLabel(pane({ spec: spec("etcds", "shop"), type: "etcds.druid.gardener.cloud" }))).toEqual({ name: "etcds", group: "", full: "etcds.druid.gardener.cloud" });
    expect(resourceLabel(pane({ spec: spec("etcds.druid.gardener.cloud", "shop"), type: "etcds.druid.gardener.cloud" })).name).toBe("etcds");
    // an alias resolves to the plural
    expect(resourceLabel(pane({ spec: spec("po", "shop"), type: "pods" }))).toEqual({ name: "pods", group: "", full: "pods" });
    expect(resourceLabel(pane({ spec: spec("machines", "shop"), type: "machines.machine.sapcloud.io", ambiguous: true }))).toEqual({ name: "machines", group: ".machine.sapcloud.io", full: "machines.machine.sapcloud.io" });
    expect(paneTitle(pane({ type: "machines.machine.sapcloud.io", ambiguous: true }))).toBe("machines.machine.sapcloud.io · shop");
    expect(paneTitle(pane({ spec: spec("deploy.apps", "shop"), type: "deployments.apps" }))).toBe("deployments · shop");
    // until resolved: as given
    expect(resourceLabel(pane({ spec: spec("deploy.apps", "shop") }))).toEqual({ name: "deploy.apps", group: "", full: "deploy.apps" });
  });
});

describe("moving tabs", () => {
  it("a tab moves to an index, the others close up; the active tab stays active", () => {
    let s = S.initialState();
    s = apply(s, S.newTab);
    s = apply(s, S.newTab); // t1 v1, t2, t3 (active)
    const order = (x: S.UIState) => x.tabs.map((t) => t.id);
    const [a, b, c] = order(s);
    s = apply(s, (x) => S.moveTab(x, c!, 0));
    expect(order(s)).toEqual([c, a, b]);
    expect(S.activeTab(s).id).toBe(c);
    s = apply(s, (x) => S.moveTab(x, a!, 2));
    expect(order(s)).toEqual([c, b, a]);
    expect(S.activeTab(s).id).toBe(c);
    // out of range clamps; unknown or the same place: unchanged
    s = apply(s, (x) => S.moveTab(x, c!, 99));
    expect(order(s)).toEqual([b, a, c]);
    expect(S.moveTab(s, "nope", 0)).toBe(s);
    expect(S.moveTab(s, c!, 2)).toBe(s);
    invariants(s);
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
    const s = S.pipelineYAML({ context: "", resource: "po", namespace: "", labelSelector: "", grep: "oom", filter: "", sort: "-AGE" });
    expect(JSON.parse(s).stages).toEqual([{ grep: "oom" }, { sort: ["-AGE"] }]);
  });
});

describe("header click sort", () => {
  it("cycles ascending, descending, kubectl's order; another column starts ascending", () => {
    expect(S.nextSort(undefined, "AGE")).toBe("AGE");
    expect(S.nextSort("AGE", "AGE")).toBe("-AGE");
    expect(S.nextSort("-AGE", "AGE")).toBeUndefined();
    expect(S.nextSort("-AGE", "NAME")).toBe("NAME");
    expect(S.sortOf("-AGE")).toEqual({ column: "AGE", desc: true });
    expect(S.sortOf("NAME")).toEqual({ column: "NAME", desc: false });
    expect(S.sortOf(undefined)).toBeUndefined();
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

  it("a click into the terminal takes the keys from its open find bar, keeping the bar", () => {
    let s = apply(S.initialState(), (x) => S.openTerminal(x, term("s1")));
    s = apply(s, (x) => S.updateFind(S.openFind(x), "v2", (f) => ({ ...f, query: "25" })));
    expect(s.focus).toBe("termfind");
    s = apply(s, (x) => S.focusTerminal(x, "v2"));
    expect(s.focus).toBe("terminal");
    expect(s.panes.v2!.term?.find).toMatchObject({ open: true, query: "25" });
    // from the table pane too
    s = apply(apply(s, S.openFind), (x) => S.cyclePane(x, -1));
    expect(apply(s, (x) => S.focusTerminal(x, "v2")).focus).toBe("terminal");
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

describe("log panes", () => {
  const logs = (id: string): S.Logs => ({ session: id, title: "api-0", context: "kind", filter: "", timestamps: false, follow: true, prefix: true });

  it("open below the source pane with logs focus", () => {
    let s = apply(S.initialState(), (x) => S.openLogs(x, logs("s1")));
    const t = S.activeTab(s);
    expect(t.focused).toBe("v2");
    expect(s.focus).toBe("logs");
    expect(s.panes.v2!.logs?.session).toBe("s1");
    // the filter field and back
    s = apply(s, (x) => ({ ...x, focus: "logsfilter" as const }));
    expect(S.setLogFilter(s, "v2", "oom").panes.v2!.logs?.filter).toBe("oom");
    expect(S.toggleLogTimestamps(s, "v2").panes.v2!.logs?.timestamps).toBe(true);
  });

  it("a log session ending keeps its pane, marked ended (logs never auto-close)", () => {
    const a = apply(S.initialState(), (x) => S.openLogs(x, logs("s1")));
    const b = apply(a, (x) => S.sessionEnded(x, "s1", "0"));
    expect(ids(b)).toEqual(["v1", "v2"]); // pane kept
    expect(b.panes.v2!.logs?.exited).toBe("ended");
    expect(S.orphanedSessions(a, b)).toEqual([]);
  });

  it("releases the log session when no pane references it", () => {
    const a = apply(S.initialState(), (x) => S.openLogs(x, logs("s1")));
    const b = apply(a, (x) => S.closePane(x));
    expect(S.orphanedSessions(a, b)).toEqual(["s1"]);
  });

  it("the log find bar focus follows the pane", () => {
    let s = apply(S.initialState(), (x) => S.openLogs(x, logs("s1")));
    s = apply(s, (x) => S.updateLogFind(S.openLogFind(x), "v2", (f) => ({ ...f, query: "err" })));
    expect(s.focus).toBe("logsfind");
    expect(s.panes.v2!.logs?.find).toMatchObject({ open: true, query: "err" });
    s = apply(s, S.closeLogFind);
    expect(s.focus).toBe("logs");
    expect(s.panes.v2!.logs?.find?.open).toBe(false);
  });
});

describe("contextNamespace", () => {
  const list = { contexts: ["a", "b"], current: "a", namespaces: { a: "shoot--x" } };
  it("uses the namespace the kubeconfig context sets, else all", () => {
    expect(S.contextNamespace(list, "")).toBe("shoot--x"); // "" = current context
    expect(S.contextNamespace(list, "a")).toBe("shoot--x");
    expect(S.contextNamespace(list, "b")).toBe("");
    expect(S.contextNamespace(undefined, "")).toBe("");
    const other = { contexts: ["@1/g", "@1/s"], current: "@1/g", namespaces: { "@1/g": "garden", "@1/s": "kube-system" } };
    expect(S.contextNamespace(other, "@1/")).toBe("garden"); // that kubeconfig's current context
    expect(S.contextNamespace(other, "@1/s")).toBe("kube-system");
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

describe("insert / insertEdge (where a dragged pane lands)", () => {
  const p = leaf;
  it("puts the pane on any side of the target, halving the target's share", () => {
    expect(insert(p("a"), "a", "left", "n")).toEqual({ type: "split", dir: "row", children: [p("n"), p("a")] });
    expect(insert(p("a"), "a", "bottom", "n")).toEqual({ type: "split", dir: "column", children: [p("a"), p("n")] });
    const l: Layout = { type: "split", dir: "row", children: [p("a"), p("b")], sizes: [0.6, 0.4] };
    expect(insert(l, "b", "left", "n")).toEqual({ type: "split", dir: "row", children: [p("a"), p("n"), p("b")], sizes: [0.6, 0.2, 0.2] });
    // across the split's direction: the target becomes a split of its own
    expect(insert(l, "a", "top", "n")).toEqual({
      type: "split",
      dir: "row",
      children: [{ type: "split", dir: "column", children: [p("n"), p("a")] }, p("b")],
      sizes: [0.6, 0.4],
    });
    expect(valid(insert(l, "a", "top", "n"))).toBe(true);
  });

  it("an edge of the tab: an equal share along it, the rest keep their proportions", () => {
    const l: Layout = { type: "split", dir: "row", children: [p("a"), p("b")], sizes: [0.6, 0.4] };
    const r = insertEdge(l, "right", "n");
    expect(r.type === "split" && r.children.map((c) => (c as { id: string }).id)).toEqual(["a", "b", "n"]);
    expect(r.type === "split" && r.sizes!.map((x) => Math.round(x * 100))).toEqual([40, 27, 33]);
    expect(edgeShare(l, "right")).toBeCloseTo(1 / 3);
    // across: the whole layout and the pane, half each
    expect(insertEdge(l, "bottom", "n")).toEqual({ type: "split", dir: "column", children: [l, p("n")] });
    expect(edgeShare(l, "bottom")).toBe(0.5);
    expect(insertEdge(p("a"), "left", "n")).toEqual({ type: "split", dir: "row", children: [p("n"), p("a")] });
  });

  it("nearestSide goes by the diagonals; sidePart is the preview", () => {
    const r = { x: 0, y: 0, w: 200, h: 100 };
    expect(nearestSide(r, 10, 50)).toBe("left");
    expect(nearestSide(r, 190, 50)).toBe("right");
    expect(nearestSide(r, 100, 5)).toBe("top");
    expect(nearestSide(r, 100, 95)).toBe("bottom");
    expect(sidePart(r, "right", 0.5)).toEqual({ x: 100, y: 0, w: 100, h: 100 });
    expect(sidePart(r, "top", 0.25)).toEqual({ x: 0, y: 0, w: 200, h: 25 });
  });
});

describe("movePane (drag and drop by the grip)", () => {
  // t1: v1 | v2 (focus v2)
  const two = () => S.splitPane(S.initialState(), "row");
  const tabIds = (s: S.UIState, i: number) => paneIds(s.tabs[i]!.layout);

  it("within a tab: next to another pane, the pane itself is kept (no new pane)", () => {
    let s = apply(two(), (x) => S.splitPane(x, "column")); // v1 | (v2 / v3), focus v3
    const v3 = s.panes.v3;
    s = apply(s, (x) => S.movePane(x, "v3", { tab: "t1", pane: "v1", side: "left" }));
    invariants(s);
    expect(s.tabs[0]!.layout).toEqual({ type: "split", dir: "row", children: [leaf("v3"), leaf("v1"), leaf("v2")] }); // unsized: equal shares, as a split
    expect(s.panes.v3).toBe(v3);
    expect(S.activeTab(s).focused).toBe("v3");
    expect(s.nextId).toBe(4);
  });

  it("onto itself, or the only pane to its own tab's edge, is no move", () => {
    const s = two();
    expect(S.movePane(s, "v2", { tab: "t1", pane: "v2", side: "left" })).toBe(s);
    expect(S.movePane(s, "v9", { tab: "t1", pane: "v1", side: "left" })).toBe(s);
    expect(S.movePane(s, "v1", { tab: "t9", side: "left" })).toBe(s);
    const one = S.initialState();
    expect(S.movePane(one, "v1", { tab: "t1", side: "left" })).toBe(one);
    expect(S.movePane(one, "v1", { newTab: true })).toBe(one);
    // targets that leave the tab arranged as it is (v1 | v2): v2 to v1's right, or to the tab's right edge
    expect(S.movePane(s, "v2", { tab: "t1", pane: "v1", side: "right" })).toBe(s);
    expect(S.movePane(s, "v2", { tab: "t1", side: "right" })).toBe(s);
    expect(S.movePane(s, "v1", { tab: "t1", pane: "v2", side: "left" })).toBe(s);
    // also when only the sizes would change
    const sized = S.setLayout(s, { type: "split", dir: "row", children: [leaf("v1"), leaf("v2")], sizes: [0.7, 0.3] });
    expect(S.movePane(sized, "v2", { tab: "t1", pane: "v1", side: "right" })).toBe(sized);
    // the others are moves: across (v2 below v1), or swapped
    expect(S.movePane(s, "v2", { tab: "t1", pane: "v1", side: "bottom" })).not.toBe(s);
    expect(S.movePane(s, "v2", { tab: "t1", pane: "v1", side: "left" })).not.toBe(s);
    // with three in a row (v1 | v2 | v3), v3 to v2's right stays put; to v1's right it moves
    const three = S.splitPane(s, "row");
    expect(S.movePane(three, "v3", { tab: "t1", pane: "v2", side: "right" })).toBe(three);
    expect(S.movePane(three, "v3", { tab: "t1", pane: "v1", side: "right" })).not.toBe(three);
    // to the edge of its own tab with others there: a move
    expect(S.movePane(s, "v2", { tab: "t1", side: "left" }).tabs[0]!.layout).toEqual({ type: "split", dir: "row", children: [leaf("v2"), leaf("v1")] });
  });

  it("to another tab: shown there, focused; the old tab focuses a neighbor", () => {
    let s = apply(two(), S.newTab); // t1: v1 | v2; t3: v3 (active)
    s = apply(s, (x) => S.gotoTab(x, 1));
    s = apply(s, (x) => S.movePane(x, "v2", { tab: "t3", pane: "v3", side: "bottom" }));
    invariants(s);
    expect(tabIds(s, 0)).toEqual(["v1"]);
    expect(s.tabs[0]!.focused).toBe("v1");
    expect(s.tabs[1]!.layout).toEqual({ type: "split", dir: "column", children: [leaf("v3"), leaf("v2")] });
    expect(s.activeTab).toBe(1);
    expect(S.activeTab(s).focused).toBe("v2");
  });

  it("the last pane of a tab: the tab closes", () => {
    let s = apply(two(), S.newTab); // t3: v3
    s = apply(s, (x) => S.movePane(x, "v3", { tab: "t1", side: "right" }));
    invariants(s);
    expect(s.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(tabIds(s, 0)).toEqual(["v1", "v2", "v3"]);
    expect(S.focusedPane(s).id).toBe("v3");
  });

  it("into a new tab, alone", () => {
    let s = apply(two(), (x) => S.movePane(x, "v1", { newTab: true }));
    invariants(s);
    expect(s.tabs.map((t) => [t.id, paneIds(t.layout)])).toEqual([
      ["t1", ["v2"]],
      ["t3", ["v1"]],
    ]);
    expect(s.activeTab).toBe(1);
    expect(s.nextId).toBe(4);
  });

  it("server panes and shells move along (nothing is released)", () => {
    let s = S.updatePane(two(), "v1", (p) => ({ ...p, serverId: "p1" }));
    s = S.openTerminal(s, { session: "s1", pod: "p", container: "c", context: "k" }, "v1"); // v3
    const next = apply(s, (x) => S.movePane(x, "v3", { newTab: true }));
    expect(S.orphanedServerPanes(s, next)).toEqual([]);
    expect(S.orphanedSessions(s, next)).toEqual([]);
    expect(next.focus).toBe("terminal");
  });

  it("un-maximizes the tabs involved", () => {
    let s = apply(apply(two(), (x) => S.splitPane(x, "column")), S.toggleMaximize); // v3 maximized
    s = apply(s, (x) => S.movePane(x, "v1", { tab: "t1", pane: "v3", side: "right" }));
    invariants(s);
    expect(S.activeTab(s).maximized).toBeUndefined();
  });
});

describe("clusters", () => {
  it("splits a terminal's kubeconfig reference off the context name", () => {
    expect(S.splitCluster("")).toEqual({ kubeconfig: "", context: "" });
    expect(S.splitCluster("dev")).toEqual({ kubeconfig: "", context: "dev" });
    expect(S.splitCluster("@1/dev")).toEqual({ kubeconfig: "@1", context: "dev" });
    expect(S.splitCluster("@12/")).toEqual({ kubeconfig: "@12", context: "" });
    expect(S.splitCluster("@1/a/b")).toEqual({ kubeconfig: "@1", context: "a/b" });
    expect(S.splitCluster("@x/dev")).toEqual({ kubeconfig: "", context: "@x/dev" });
    expect(S.clusterLabel("@3/shoot--p--s")).toBe("shoot--p--s");
    expect(S.clusterLabel("@3/")).toBe("(current)");
  });

  it("a reconnect retries the table panes on its cluster whose open failed", () => {
    let s = S.splitPane(S.splitPane(S.initialState("dev"), "row"), "row"); // v1 v2 v3 on dev
    s = S.updatePane(s, "v1", (p) => ({ ...p, error: "dial tcp: connection refused" }));
    s = S.updatePane(s, "v2", (p) => ({ ...p, serverId: "p2" }));
    s = S.updatePane(s, "v3", (p) => ({ ...p, error: "forbidden", spec: { ...p.spec, context: "prod" } }));
    expect(S.failedPanes(s, "dev")).toEqual(["v1"]);
    expect(S.failedPanes(s, "prod")).toEqual(["v3"]);
    expect(S.failedPanes(s, "")).toEqual([]);
  });

  it("a launch opens a fresh tab on its cluster, not a copy of the focused one", () => {
    let s = S.initialState("dev", "shop");
    s = S.updatePane(s, "v1", (p) => ({ ...p, spec: { ...p.spec, resource: "deployments", filter: "x" } }));
    const next = apply(s, (x) => S.launchTab(x, "@1/shoot", "kube-system"));
    expect(next.tabs).toHaveLength(2);
    expect(next.activeTab).toBe(1);
    const p = S.focusedPane(next);
    expect(p.spec).toEqual(S.initialSpec("@1/shoot", "kube-system"));
    // ⌘T from there stays on that kubeconfig's context
    expect(S.focusedPane(apply(next, S.newTab)).spec.context).toBe("@1/shoot");
    expect(next.panes.v1!.spec.resource).toBe("deployments");
  });
});

describe("object views (⏎ in place, ⇧⏎ in a split)", () => {
  // a table pane on a server pane, the way applySpec leaves it
  const table = (s = S.initialState("kind")): S.UIState => S.updatePane(s, "v1", (p) => ({ ...p, serverId: "p1", context: "kind", kind: "Pod", type: "pods" }));
  const inPlace = (o: Partial<S.ObjectView> = {}) => apply(table(), (x) => S.openObject(x, "v1", { key: "u1", view: "yaml", ...o }));
  const inSplit = (o: Partial<S.ObjectView> = {}) => apply(table(), (x) => S.openObjectSplit(x, { key: "u1", view: "yaml", ...o }, "v1"));

  it("⏎ shows the object over the table, a step in its history; Esc goes back to it", () => {
    let s = inPlace();
    invariants(s);
    expect(ids(s)).toEqual(["v1"]);
    expect(s.panes.v1!.object).toMatchObject({ key: "u1", view: "yaml", split: false });
    expect(s.focus).toBe("detail");
    expect(s.panes.v1!.back).toEqual([{ spec: s.panes.v1!.spec, key: "u1", object: undefined }]);
    s = apply(s, (x) => S.leaveObject(x, "v1"));
    expect(s.panes.v1!.object).toBeUndefined();
    expect(s.panes.v1!.serverId).toBe("p1"); // the same table, scrolled as it was
    expect(s.panes.v1!.back).toBeUndefined();
    expect(s.panes.v1!.forward).toEqual([{ spec: s.panes.v1!.spec, key: "u1", object: expect.objectContaining({ key: "u1" }) }]);
    expect(s.focus).toBe("table");
  });

  it("⌘→ after Esc shows the object again; ⌘← goes back to the table", () => {
    let s = apply(inPlace({ diff: true }), (x) => S.leaveObject(x, "v1"));
    const fwd = S.moveHistory(s, "v1", "forward", "u1");
    s = apply(fwd.state, (x) => x);
    expect(s.panes.v1!.object).toMatchObject({ key: "u1", diff: true });
    expect(s.panes.v1!.reselect).toBe("u1"); // its row, selected under it for Esc
    expect(s.focus).toBe("detail");
    s = apply(S.moveHistory(s, "v1", "back", undefined).state, (x) => x);
    expect(s.panes.v1!.object).toBeUndefined();
    expect(s.panes.v1!.reselect).toBe("u1");
    expect(s.focus).toBe("table");
  });

  it("⇧⏎ opens a pane to the right on the table's server pane, without changing it", () => {
    const s = inSplit();
    invariants(s);
    expect(ids(s)).toEqual(["v1", "v2"]);
    const l = S.activeTab(s).layout;
    expect(l.type === "split" && l.dir).toBe("row");
    expect(s.panes.v2).toMatchObject({ serverId: "p1", leased: true, context: "kind", object: { key: "u1", split: true, from: "v1" } });
    expect(s.panes.v1!.object).toBeUndefined();
    expect(S.activeTab(s).focused).toBe("v2");
    expect(s.focus).toBe("detail");
    // the server pane stays while either holds it
    expect(S.orphanedServerPanes(s, apply(s, (x) => S.closePane(x, "v1")))).toEqual([]);
    expect(S.orphanedServerPanes(s, apply(s, (x) => S.closeTab(x)))).toEqual(["p1"]);
  });

  it("Esc at the top of a split closes it; the focus goes back to its table", () => {
    const s = apply(table(), (x) => S.splitPane(x, "row")); // v2 between them
    let t = apply(s, (x) => S.focusPane(x, "v1"));
    t = apply(t, (x) => S.openObjectSplit(x, { key: "u1", view: "yaml" }, "v1")); // v3, right of v1
    expect(ids(t)).toEqual(["v1", "v3", "v2"]);
    t = apply(t, (x) => S.focusPane(x, "v2"));
    t = apply(t, (x) => S.focusPane(x, "v3"));
    t = apply(t, (x) => S.leaveObject(x, "v3"));
    invariants(t);
    expect(ids(t)).toEqual(["v1", "v2"]);
    expect(S.activeTab(t).focused).toBe("v1");
    expect(t.focus).toBe("table");
  });

  it("a held Esc (key repeat) stops at the top: nothing goes back or closes", () => {
    const s = inSplit();
    expect(S.leaveObject(s, "v2", true)).toBe(s);
    const p = inPlace();
    expect(S.leaveObject(p, "v1", true)).toBe(p);
  });

  it("follow: off by default; on, the table's selection is shown; it stops once the table goes or changes source", () => {
    let s = inSplit({ diff: true, version: 3 });
    expect(s.panes.v2!.object!.follow).toBeUndefined();
    s = apply(s, (x) => S.setFollow(x, "v2", true));
    expect(s.panes.v2!.object!.follow).toBe(true);
    s = apply(s, (x) => S.followTo(x, "v2", "u2"));
    // the diff from the newest version, of the row now selected
    expect(s.panes.v2!.object).toMatchObject({ key: "u2", diff: true, version: undefined, follow: true });
    // the same key again: unchanged
    expect(S.followTo(s, "v2", "u2")).toBe(s);
    // the table shows another source now: following stops, with why
    const other = S.checkFollow(S.updatePane(s, "v1", (p) => ({ ...p, serverId: "p9" })));
    expect(other.panes.v2!.object).toMatchObject({ follow: undefined, followOff: "the table it came from shows another source now" });
    expect(S.setFollow(other, "v2", true)).toBe(other); // can't be turned on again
    const closed = S.checkFollow(apply(s, (x) => S.closePane(x, "v1")));
    expect(closed.panes.v2!.object).toMatchObject({ follow: undefined, followOff: "the table it came from was closed" });
    // off again by hand: it stays on the object shown
    s = apply(s, (x) => S.setFollow(x, "v2", false));
    expect(S.followTo(s, "v2", "u3")).toBe(s);
  });

  it("an object view in place has nothing to follow", () => {
    const s = inPlace();
    expect(S.followBlocked(s, s.panes.v1!)).toBe("opened from no table");
    expect(S.setFollow(s, "v1", true)).toBe(s);
  });

  it("⇧⏎ in a split object view opens another split from the same table", () => {
    let s = inSplit();
    s = apply(s, (x) => S.openObjectSplit(x, s.panes.v2!.object!, "v2"));
    expect(ids(s)).toEqual(["v1", "v2", "v3"]);
    expect(s.panes.v3!.object).toMatchObject({ from: "v1", split: true });
  });

  it("the history keeps an object view but not its editor", () => {
    const edit: S.EditState = { session: "e1", key: "u1", title: "Pod web", opened: "a", yaml: "b" };
    let s = inPlace({ edit, viaEdit: true });
    expect(s.focus).toBe("edit");
    expect(S.unsaved(s.panes.v1)).toBe(true);
    s = apply(s, (x) => S.pushHistory(x, "v1", "u1"));
    expect(s.panes.v1!.back!.at(-1)!.object).toEqual({ key: "u1", view: "yaml", split: false, from: undefined, follow: undefined, followOff: undefined });
  });

  it("an edit session no pane holds any more is closed; one being confirmed is kept", () => {
    const edit: S.EditState = { session: "e1", key: "u1", title: "Pod web", opened: "a", yaml: "b" };
    // a split never takes the editor along (the session is the pane's it was opened in)
    expect(inSplit({ edit }).panes.v2!.object!.edit).toBeUndefined();
    const s = apply(inSplit(), (x) => S.setObject(x, "v2", (o) => ({ ...o, edit })));
    const closed = apply(s, (x) => S.closePane(x, "v2"));
    expect(S.orphanedEdits(s, closed)).toEqual(["e1"]);
    const confirming = { ...closed, overlay: { kind: "confirm" as const, pane: "v2", edit, restore: "edit" as const } };
    expect(S.orphanedEdits(s, confirming)).toEqual([]);
  });

  it("the focus context follows what the object view shows: viewer, editor, dry-run diff", () => {
    const edit: S.EditState = { session: "e1", key: "u1", title: "Pod web", opened: "a", yaml: "a" };
    let s = inPlace();
    expect(s.focus).toBe("detail");
    s = apply(s, (x) => S.setObject(x, "v1", (o) => ({ ...o, edit })));
    expect(s.focus).toBe("edit");
    s = apply(s, (x) => S.setEdit(x, "v1", (e) => ({ ...e, preview: { patch: "", prevNorm: "a", curNorm: "b" } })));
    expect(s.focus).toBe("editpreview");
  });
});

describe("object diff versions ([ / ])", () => {
  const range = { to: 5, first: 3, last: 5 };
  const diffOpen = (version?: number): S.UIState =>
    S.updatePane(S.initialState(), "v1", (p) => ({ ...p, object: { key: "u1", view: "yaml", diff: true, version } }));
  const version = (s: S.UIState) => s.panes.v1!.object!.version;

  it("steps back to older versions and stops at the oldest kept", () => {
    let s = S.stepVersion(diffOpen(), "v1", -1, range);
    expect(version(s)).toBe(4);
    s = S.stepVersion(s, "v1", -1, { ...range, to: 4 });
    expect(version(s)).toBe(3);
    const same = S.stepVersion(s, "v1", -1, { ...range, to: 3 });
    expect(same).toBe(s);
  });

  it("quick presses add up while the last step is still loading", () => {
    // range still the newest's (v5), version already asked for v4: the next [ goes to v3
    expect(version(S.stepVersion(diffOpen(4), "v1", -1, range))).toBe(3);
    expect(S.stepVersion(diffOpen(3), "v1", -1, range)).toEqual(diffOpen(3));
  });

  it("back at the newest it follows new versions again", () => {
    const s = S.stepVersion(diffOpen(4), "v1", 1, { ...range, to: 4 });
    expect(version(s)).toBeUndefined();
    expect(version(S.stepVersion(diffOpen(), "v1", 1, range))).toBeUndefined();
  });

  it("only in the object diff, once loaded", () => {
    const yaml = S.updatePane(S.initialState(), "v1", (p) => ({ ...p, object: { key: "u1", view: "yaml" } }));
    expect(S.stepVersion(yaml, "v1", -1, range)).toBe(yaml);
    const describe = S.updatePane(S.initialState(), "v1", (p) => ({ ...p, object: { key: "u1", view: "describe", diff: true } }));
    expect(S.stepVersion(describe, "v1", -1, range)).toBe(describe);
    expect(version(S.stepVersion(diffOpen(), "v1", -1, undefined))).toBeUndefined();
  });
});

describe("decode (⏎ in an object view)", () => {
  const viewing = (diff = false): S.UIState => S.updatePane(S.initialState(), "v1", (p) => ({ ...p, object: { key: "u1", view: "yaml", diff } }));
  const decoding = (levels: S.DecodeState["levels"], diff = false): S.UIState =>
    S.setObject(viewing(diff), "v1", (o) => ({ ...o, decode: { levels, diff, which: diff ? "norm" : "yaml", gen: 0 } }));
  const resolved = [{ line: 3, path: [{ key: "data" }, { key: "yaml.br" }], steps: ["base64", "brotli"] }];
  const dec = (s: S.UIState) => s.panes.v1!.object!.decode;

  it("⏎ decodes the line under the cursor, of the YAML or of the diff's normalized side", () => {
    expect(dec(S.decodeDeeper(viewing(), "v1", 4))).toEqual({ levels: [{ line: 4, steps: null }], diff: false, which: "yaml", version: undefined, gen: 0 });
    expect(dec(S.decodeDeeper(viewing(true), "v1", 4))).toMatchObject({ diff: true, which: "norm" });
    const describe = S.updatePane(S.initialState(), "v1", (p) => ({ ...p, object: { key: "u1", view: "describe" } }));
    expect(S.decodeDeeper(describe, "v1", 4)).toBe(describe);
  });

  it("deeper adds a level from the decoded view's line; up removes it, then back to the object", () => {
    let s = S.decodeDeeper(decoding(resolved), "v1", 7);
    expect(dec(s)?.levels).toEqual([...resolved, { line: 7, steps: null }]);
    expect(dec(s)?.gen).toBe(1);
    s = S.decodeUp(s, "v1");
    expect(dec(s)?.levels).toEqual(resolved);
    s = S.decodeUp(s, "v1");
    expect(s.panes.v1!.object).toEqual(viewing().panes.v1!.object);
    // nothing decoded: unchanged (Esc then leaves the object view)
    expect(S.decodeUp(s, "v1")).toBe(s);
  });

  it("a decoded diff has two values under the cursor: no deeper level", () => {
    const s = decoding(resolved, true);
    expect(S.decodeDeeper(s, "v1", 7)).toBe(s);
  });

  it("a refused deeper level goes without reloading the level shown", () => {
    const s = S.decodeDeeper(decoding(resolved), "v1", 7); // gen 1, the new level not resolved
    const back = S.decodeUp(s, "v1");
    expect(dec(back)?.levels).toEqual(resolved);
    expect(dec(back)?.gen).toBe(1);
  });

  it("keeps the resolved levels (paths), once, without reloading", () => {
    const s = S.decodeResolved(decoding([{ line: 3, steps: null }]), "v1", resolved);
    expect(dec(s)?.levels).toEqual(resolved);
    expect(dec(s)?.gen).toBe(0);
    expect(S.decodeResolved(s, "v1", resolved)).toBe(s);
  });

  it("a click on a step leaves it and what follows out; on the rendering, raw; ↺ detects again", () => {
    let s = S.decodeToggle(decoding(resolved), "v1", resolved, 1);
    expect(dec(s)?.levels[0]).toMatchObject({ steps: ["base64"], raw: false });
    expect(dec(s)?.toggled).toBe(true);
    s = S.decodeToggle(s, "v1", dec(s)!.levels, "render");
    expect(dec(s)?.levels[0]).toMatchObject({ steps: ["base64"], raw: true });
    s = S.decodeAuto(s, "v1");
    expect(dec(s)?.levels[0]).toMatchObject({ steps: null, raw: false, path: resolved[0]!.path });
    expect(dec(s)?.toggled).toBe(false);
  });

  it("[ / ] step the decoded diff's versions as the object diff's", () => {
    const range = { to: 5, first: 3, last: 5 };
    let s = S.stepVersion(decoding(resolved, true), "v1", -1, range);
    expect(dec(s)?.version).toBe(4);
    expect(dec(s)?.gen).toBe(1);
    s = S.stepVersion(s, "v1", 1, { ...range, to: 4 });
    expect(dec(s)?.version).toBeUndefined();
    // not in a decoded value (no diff)
    const single = decoding(resolved);
    expect(S.stepVersion(single, "v1", -1, range)).toBe(single);
  });

  it("a decoded level opened in a split keeps its levels there", () => {
    const s = S.updatePane(decoding(resolved), "v1", (p) => ({ ...p, serverId: "p1" }));
    const t = apply(s, (x) => S.openObjectSplit(x, x.panes.v1!.object!, "v1"));
    expect(t.panes.v2!.object!.decode?.levels).toEqual(resolved);
  });
});

describe("clusterSpec", () => {
  it("lists nothing yet, in the cluster's namespace; a launched tab takes it", () => {
    const spec = S.clusterSpec("@2/live/shoot--foo--bar", "kube-system");
    expect(spec).toEqual({ ...S.initialSpec("@2/live/shoot--foo--bar", "kube-system"), resource: "" });
    expect(S.emptySpec(spec)).toBe(true);
    expect(S.emptySpec(S.initialSpec())).toBe(false);
    const s = S.launchTab(S.initialState(), "@2/live/shoot--foo--bar", "kube-system", spec);
    expect(S.focusedPane(s).spec).toBe(spec);
  });
});
