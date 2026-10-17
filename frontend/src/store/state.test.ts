import { describe, expect, it } from "vitest";
import { paneIds, valid } from "./layout";
import * as S from "./state";

const ids = (s: S.UIState) => paneIds(S.activeTab(s).layout);

function invariants(s: S.UIState) {
  expect(s.tabs.length).toBeGreaterThan(0);
  for (const t of s.tabs) {
    expect(valid(t.layout)).toBe(true);
    expect(paneIds(t.layout)).toContain(t.focused); // focus always lands on an existing pane
    for (const id of paneIds(t.layout)) expect(s.panes[id]).toBeDefined();
  }
  const all = s.tabs.flatMap((t) => paneIds(t.layout)).sort();
  expect(Object.keys(s.panes).sort()).toEqual(all); // no leaked panes
}

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
    s = S.closePane(s);
    expect(ids(s)).toEqual(["v1", "v2"]);
    expect(S.activeTab(s).focused).toBe("v2");
    s = S.closePane(S.closePane(s));
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
    let s = S.initialState();
    for (let i = 0; i < 2000; i++) {
      s = ops[Math.floor(rnd() * ops.length)]!(s);
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
