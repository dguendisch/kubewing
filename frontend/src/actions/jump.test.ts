import { describe, expect, it } from "vitest";
import type { ClusterEntry, Relations } from "../transport/types";
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

  it("keeps each entry's resource type (set apart from the name in the menu)", () => {
    const typed: Relations = { ...pod, items: [{ ...pod.items[2]!, type: "replicaset" }] };
    const clusters: Relations = { ...pod, items: [], clusters: [{ id: "cluster:seed", label: "seed loam", type: "seed", entry: { name: "g/seed--loam" } as ClusterEntry }] };
    expect(jumpItems(typed).find((i) => i.id === "owner:rs")?.type).toBe("replicaset");
    expect(jumpItems(clusters).find((i) => i.id === "cluster:seed")?.type).toBe("seed");
    expect(jumpItems(typed).find((i) => i.id === "scan")?.type).toBeUndefined();
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

  it("references follow the owned section (scan results included), before events; gone or none are disabled", () => {
    const pvc: Relations = {
      kind: "PersistentVolumeClaim", name: "data", namespace: "shop", scan: true,
      items: [
        { id: "events", section: "events", label: "events", count: 0, target: { resource: "events" } },
        { id: "ref:v1/PersistentVolume//pv-1", section: "reference", label: "persistentvolume pv-1", name: "pv-1", target: { resource: "persistentvolumes", filter: 'o.metadata.name == "pv-1"' } },
        { id: "ref:storage.k8s.io/v1/VolumeAttachment", section: "reference", label: "volumeattachments", count: 1, target: { resource: "volumeattachments.storage.k8s.io" } },
      ],
    };
    const scanned = { scanned: { items: [{ id: "scan:cm", section: "owned" as const, label: "configmaps", count: 1, target: { resource: "configmaps" } }], scanned: 3 } };
    expect(jumpItems(pvc, scanned).map((i) => i.section)).toEqual(["owner", "owned", "owned", "reference", "reference", "events"]);
    expect(view(jumpItems(pvc)).slice(2, 4)).toEqual(["persistentvolume pv-1 |  |  | 0", "volumeattachments | 1 |  | 0"]);
    const gone = jumpItems({
      ...pvc,
      items: [
        { id: "ref:pv", section: "reference", label: "persistentvolume pv-9", name: "pv-9", gone: "deleted" },
        { id: "ref:va", section: "reference", label: "volumeattachments", count: 0, target: { resource: "volumeattachments.storage.k8s.io" } },
      ],
    });
    expect(view(gone).slice(-2)).toEqual(["persistentvolume pv-9 |  | deleted | 0", "volumeattachments | 0 | none | 0"]);
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

describe("jump menu field section", () => {
  it("from an object's YAML: the references at the cursor come first, the highlight on the first that can go; missing ones are disabled", () => {
    const field = [
      { id: "field:v1/Secret/shop/gizmo-token", section: "field" as const, label: "secret gizmo-token", gone: "missing" },
      { id: "field:v1/Secret/shop/db", section: "field" as const, label: "secret db", places: 2, target: { resource: "secrets", namespace: "shop", filter: 'o.metadata.name == "db"' } },
      { id: "field:v1/Node//n", section: "field" as const, label: "node n", note: "not checked: forbidden", target: { resource: "nodes" } },
    ];
    const items = jumpItems(pod, { field });
    expect(view(items).slice(0, 4)).toEqual(["secret gizmo-token |  | missing | 0", "secret db | 2× |  | 0", "node n |  |  | 0", "pods in shop |  |  | 0"]);
    expect(items[2]!.note).toBe("not checked: forbidden");
    expect(firstJumpable(items)).toBe(1);
    // nothing at the cursor: as from the table
    expect(firstJumpable(jumpItems(pod, { field: [] }))).toBe(2);
  });
});

describe("jump menu clusters", () => {
  const entry = (x: Partial<ClusterEntry>): ClusterEntry => ({ used: "", from: "jump", rule: { context: "", confirm: [] }, garden: "live", ...x });
  const shoot: Relations = {
    kind: "Shoot", name: "bar", namespace: "garden-foo", scan: true,
    items: [{ id: "ns:object", section: "namespace", label: "namespace object garden-foo", target: { resource: "namespaces" } }],
    clusters: [
      { id: "cluster:shoot", label: "shoot bar", entry: entry({ namespace: "garden-foo", shoot: "bar", name: "live/shoot--foo--bar" }) },
      { id: "cluster:controlPlane", label: "control plane of bar", entry: entry({ namespace: "garden-foo", shoot: "bar", controlPlane: true, disabled: "garden live: kubeconfig gone" }) },
    ],
  };

  it("come first, after the field's references; the highlight starts on them; disabled ones say why", () => {
    const items = jumpItems(shoot);
    expect(items.map((i) => i.section).slice(0, 3)).toEqual(["clusters", "clusters", "namespace"]);
    expect(view(items).slice(0, 2)).toEqual(["shoot bar | live/shoot--foo--bar |  | 0", "control plane of bar |  | garden live: kubeconfig gone | 0"]);
    expect(items[0]!.cluster?.shoot).toBe("bar");
    expect(items[0]!.target).toBeUndefined();
    expect(firstJumpable(items)).toBe(0);
    const field = [{ id: "f", section: "field" as const, label: "seed soil", target: { resource: "seeds" } }];
    expect(jumpItems(shoot, { field }).map((i) => i.section).slice(0, 2)).toEqual(["field", "clusters"]);
  });
});
