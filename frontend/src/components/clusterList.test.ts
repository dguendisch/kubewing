import { describe, expect, it } from "vitest";
import type { ClusterEntry, ClusterList } from "../transport/types";
import { entryDetail, entryLabel, isPath, items, keepIndex, since } from "./clusterList";

const now = new Date("2026-11-02T12:00:00Z");
const rule = { context: "", confirm: [] };
const e = (x: Partial<ClusterEntry>): ClusterEntry => ({ used: "0001-01-01T00:00:00Z", from: "recent", rule, ...x });

const shoot = e({ garden: "live", project: "foo", namespace: "garden-foo", shoot: "bar", used: "2026-11-02T10:00:00Z", name: "live/shoot--foo--bar" });
const cp = e({ garden: "live", namespace: "garden-foo", shoot: "bar", controlPlane: true, used: "2026-11-02T11:59:30Z", from: "gardenctl" });
const kc = e({ kubeconfig: ["/Users/jd/.kube/config"], context: "kind-dev", used: "2026-10-30T12:00:00Z" });
const project = e({ garden: "live", namespace: "garden", used: "2026-11-01T11:00:00Z" });
const garden = e({ garden: "live", from: "garden" });
const list: ClusterList = { recent: [cp, shoot, project, kc], gardens: [garden] };

describe("cluster list", () => {
  it("labels and details", () => {
    expect([shoot, cp, kc, project, garden].map(entryLabel)).toEqual(["bar", "bar · control plane", "kind-dev", "project garden", "live"]);
    expect(entryDetail(shoot, now)).toBe("foo · live · 2h ago");
    expect(entryDetail(cp, now)).toBe("foo · live · gardenctl · just now");
    expect(entryDetail(kc, now)).toBe("~/.kube/config · 3d ago");
    expect(entryDetail(garden, now)).toBe("garden");
    expect(since("0001-01-01T00:00:00Z", now)).toBe("");
    expect(since("2026-11-02T11:55:00Z", now)).toBe("5m ago");
  });

  it("empty text: every recent one in order, then the gardens", () => {
    expect(items(list, [], "", now).map((i) => i.entry)).toEqual([cp, shoot, project, kc, garden]);
  });

  it("typing ranks by shoot, project, context, technical id", () => {
    expect(items(list, [], "kind", now)[0]!.entry).toBe(kc);
    // the shoot and its control plane both: the recent order decides
    expect(items(list, [], "shoot--foo--bar", now).map((i) => i.entry).slice(0, 2)).toEqual([cp, shoot]);
    const foo = items(list, [], "foo", now).map((i) => i.entry);
    expect(foo.slice(0, 2)).toEqual([cp, shoot]);
  });

  it("a pasted URL: its targets only", () => {
    const m = [e({ ...shoot, from: "match", used: "" }), e({ ...cp, from: "match", used: "" })];
    const got = items(list, m, "https://dashboard.example/namespace/garden-foo/shoots/bar", now);
    expect(got.map((i) => i.entry)).toEqual(m);
    // a plain word that matched a pattern still ranks the recent ones below
    expect(items(list, m.slice(0, 1), "bar", now).length).toBeGreaterThan(1);
  });

  it("a path: that kubeconfig", () => {
    expect(isPath("~/kc")).toBe(true);
    expect(isPath("kind")).toBe(false);
    const got = items(list, [], "~/.kube/other", now);
    expect(got).toHaveLength(1);
    expect(got[0]!.entry.kubeconfig).toEqual(["~/.kube/other"]);
  });

  it("highlight follows its entry, else the first pickable", () => {
    const a = items(list, [], "", now);
    const b = items({ ...list, recent: list.recent.slice(1) }, [], "", now);
    expect(keepIndex(a[1], b)).toBe(0);
    const disabled = items({ recent: [e({ ...kc, disabled: "gone" }), shoot], gardens: [] }, [], "", now);
    expect(keepIndex(undefined, disabled)).toBe(1);
  });
});
