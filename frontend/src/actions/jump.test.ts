import { describe, expect, it } from "vitest";
import type { Relations } from "../transport/types";
import { firstJumpable, jumpItems } from "./jump";

const pod: Relations = {
  kind: "Pod",
  name: "web-7d9f-a",
  namespace: "shop",
  scan: true,
  items: [
    { id: "ns:here", section: "namespace", label: "pods in shop", name: "shop", target: { resource: "pods", namespace: "shop" } },
    { id: "ns:object", section: "namespace", label: "namespace object shop", target: { resource: "namespaces", filter: 'o.metadata.name == "shop"' } },
    { id: "owner:rs", section: "owner", label: "replicaset web-7d9f", depth: 1, controller: true, target: { resource: "replicasets.apps", namespace: "shop" } },
    { id: "owner:d", section: "owner", label: "deployment web", depth: 2, controller: true, target: { resource: "deployments.apps", namespace: "shop" } },
    { id: "owner:old", section: "owner", label: "replicaset old", depth: 1, gone: "deleted" },
  ],
};

const view = (items: ReturnType<typeof jumpItems>) => items.map((i) => [i.label, i.detail ?? "", i.disabled ?? "", i.indent ?? 0].join(" | "));

describe("jump menu items", () => {
  it("owners indent up the chain; gone ones are disabled with why; the scan is offered", () => {
    expect(view(jumpItems(pod))).toEqual([
      "pods in shop |  |  | 0",
      "namespace object shop |  |  | 0",
      "replicaset web-7d9f | controller |  | 0",
      "deployment web | controller |  | 1",
      "replicaset old |  | deleted | 0",
      "scan for owned… | in shop |  | 0",
    ]);
    // the highlight starts on the first owner, not on the namespace
    expect(firstJumpable(jumpItems(pod))).toBe(2);
  });

  it("events come last, after the scan's entries; zero events can still be watched", () => {
    const ev = (count: number) => ({ id: "events", section: "events" as const, label: "events", count, target: { resource: "events", namespace: "shop", fieldSelector: "involvedObject.kind=Pod,involvedObject.name=web-7d9f-a" } });
    const rel = { ...pod, items: [ev(0), ...pod.items] };
    const scanned = { scanned: { items: [{ id: "scan:cm", section: "owned" as const, label: "configmaps", count: 1, target: { resource: "configmaps" } }], scanned: 3 } };
    const items = jumpItems(rel, scanned);
    expect(items.map((i) => i.section).slice(-3)).toEqual(["owned", "owned", "events"]);
    expect(view(items).at(-1)).toBe("events | 0 |  | 0");
    expect(view(jumpItems({ ...pod, items: [...pod.items, ev(3)] })).at(-1)).toBe("events | 3 |  | 0");
  });

  it("owned counts: zero is disabled, uncounted keeps its note", () => {
    const deploy: Relations = {
      kind: "Deployment", name: "web", namespace: "shop", scan: true,
      items: [
        { id: "owned:rs", section: "owned", label: "replicasets", count: 1, target: { resource: "replicasets.apps", namespace: "shop" } },
        { id: "owned:pods", section: "owned", label: "pods", count: 0, target: { resource: "pods", namespace: "shop" } },
        { id: "owned:jobs", section: "owned", label: "jobs", note: "not counted: forbidden", target: { resource: "jobs.batch" } },
      ],
    };
    const items = jumpItems(deploy);
    expect(view(items)).toEqual([
      "no owner |  | no ownerReferences | 0",
      "replicasets | 1 |  | 0",
      "pods | 0 | none | 0",
      "jobs |  |  | 0",
      "scan for owned… | in shop |  | 0",
    ]);
    expect(items[3]!.note).toBe("not counted: forbidden");
    expect(firstJumpable(items)).toBe(1);
  });

  it("scan results replace the entry; kinds already listed aren't repeated", () => {
    const widget: Relations = {
      kind: "Widget", name: "gizmo", namespace: "shop", scan: true,
      items: [{ id: "owned:pods", section: "owned", label: "pods", kind: "Pod", count: 1, target: { resource: "pods", namespace: "shop", labelSelector: "widget=gizmo" } }],
    };
    expect(view(jumpItems(widget, { scanning: true })).at(-1)).toBe("scanning all types… |  | scanning | 0");
    const done = jumpItems(widget, {
      scanned: {
        scanned: 40, skipped: 2, skipReason: "forbidden",
        items: [
          { id: "scan:configmaps", section: "owned", label: "configmaps", kind: "ConfigMap", count: 2, target: { resource: "configmaps", namespace: "shop" } },
          // the same kind as the known entry, under another resource name (pods vs pods.v1): by kind, not repeated
          { id: "scan:pods", section: "owned", label: "pods", kind: "Pod", count: 1, target: { resource: "pods.v1", namespace: "shop" } },
        ],
      },
    });
    expect(view(done).slice(-3)).toEqual(["pods | 1 |  | 0", "configmaps | 2 |  | 0", "scan done |  | scanned 40 types, 2 skipped (forbidden) | 0"]);
    const nothing = jumpItems(widget, { scanned: { scanned: 1, items: [] } });
    expect(view(nothing).at(-1)).toBe("nothing else owned |  | scanned 1 type | 0");
  });

  it("a cluster-scoped owner's scan asks first", () => {
    const node: Relations = { kind: "Node", name: "n1", scan: true, scanAll: true, items: [] };
    const ask = jumpItems(node).at(-1)!;
    expect([ask.label, ask.detail, ask.note, ask.scan]).toEqual(["scan for owned…", "all namespaces", "lists every type in every namespace", true]);
    expect(jumpItems(node, { scanAsked: true }).at(-1)!.label).toBe("scan all namespaces and cluster types — ⏎ again");
    expect(jumpItems(node, { scanError: "not loaded" }).at(-1)!.note).toBe("not loaded");
  });

  it("without a uid there is nothing to scan for", () => {
    expect(view(jumpItems({ kind: "X", name: "x", items: [] }))).toEqual(["no owner |  | no ownerReferences | 0", "nothing known |  | no uid to look for | 0"]);
  });
});
