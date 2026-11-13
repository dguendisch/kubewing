import { describe, expect, it } from "vitest";
import { commandIds, defaultBindings, mergeBindings } from "../keys/keymap";
import type { MarkedRow, RowInfo, SafetyRule } from "../transport/types";
import { menuFor, rowActions } from "./registry";
// the dispatcher's source, to check every menu command is handled
import commandsSrc from "../commands.ts?raw";

const pod: RowInfo = { key: "u1", kind: "Pod", name: "web-0", namespace: "shop", pod: true, logs: true, hasPrev: true, containers: ["app"], ports: [8080], restart: "pod can't be restarted" };
const cm: RowInfo = { key: "u2", kind: "ConfigMap", name: "cfg", namespace: "shop", restart: "configmap can't be restarted" };
const ro: SafetyRule = { context: "prod", label: "PROD", readOnly: true, confirm: ["delete"] };

const byCmd = (items: ReturnType<typeof menuFor>) => Object.fromEntries(items.map((i) => [i.command, i]));

describe("row actions menu", () => {
  it("a pod offers everything but scale and restart, with its table shortcuts", () => {
    const m = byCmd(menuFor(pod, undefined));
    expect(Object.values(m).filter((i) => i.disabled).map((i) => i.command)).toEqual(["object.scale", "object.restart"]);
    expect(m["object.label"]!.shortcut).toBe("⇧L");
    expect(m["object.annotate"]!.shortcut).toBe("⇧A");
    expect(m["object.describe"]!.shortcut).toBe("d");
    expect(m["object.exec"]!.shortcut).toBe("x");
    expect(m["object.edit"]!.shortcut).toBe("e");
    expect(m["object.delete"]!.shortcut).toBe("⌘⌫");
    expect(m["object.portForward"]!.shortcut).toBe("f");
    expect(m["object.events"]).toMatchObject({ shortcut: "v", split: "object.eventsSplit", splitShortcut: "⇧V" });
    expect(m["detail.open"]!.shortcut).toBe("⏎");
  });

  it("explains why entries are unavailable", () => {
    const m = byCmd(menuFor(cm, undefined));
    expect(m["object.exec"]!.disabled).toBe("needs a pod, not configmap");
    expect(m["object.logs"]!.disabled).toBe("no pods to tail");
    expect(m["object.portForward"]!.disabled).toBe("needs a pod or service, not configmap");
    // a service forwards to one of its pods
    const svc = byCmd(menuFor({ key: "s1", kind: "Service", name: "web", namespace: "shop", service: true }, undefined));
    expect(svc["object.portForward"]!.disabled).toBeUndefined();
    expect(svc["object.exec"]!.disabled).toBe("needs a pod, not service");
    expect(m["object.opsPod"]!.disabled).toBe("needs a node or pod, not configmap");
    // a node row: everything pod-only is off, the ops pod is on
    const node = byCmd(menuFor({ key: "n1", kind: "Node", name: "n1" }, undefined));
    expect(node["object.opsPod"]!.disabled).toBeUndefined();
    expect(node["object.opsPod"]!.shortcut).toBe("n");
    expect(node["object.exec"]!.disabled).toBe("needs a pod, not node");
    expect(m["object.diff"]!.disabled).toBe("no change seen yet");
    expect(m["object.describe"]!.disabled).toBeUndefined();

    const gone = byCmd(menuFor({ ...pod, deleted: true }, undefined));
    expect(gone["object.delete"]!.disabled).toBe("deleted");
    expect(gone["object.exec"]!.disabled).toBe("deleted");
    expect(gone["detail.open"]!.disabled).toBeUndefined(); // the last state is still viewable
    expect(gone["object.events"]!.disabled).toBeUndefined(); // events outlive their object

    expect(m["object.scale"]!).toMatchObject({ label: "scale…", disabled: "configmap has no replicas" });
    const deploy = byCmd(menuFor({ key: "d1", kind: "Deployment", name: "web", namespace: "shop", replicas: 3 }, undefined));
    expect(deploy["object.scale"]).toMatchObject({ label: "scale… (3)", shortcut: "s", disabled: undefined });
    expect(byCmd(menuFor({ key: "d1", kind: "Deployment", name: "web", replicas: 0 }, ro))["object.scale"]!.disabled).toBe("read-only context");

    // Go says why a row can't be restarted (kind, paused); without a reason it can
    expect(m["object.restart"]!.disabled).toBe("configmap can't be restarted");
    expect(deploy["object.restart"]).toMatchObject({ label: "rollout restart…", shortcut: "r", disabled: undefined });
    expect(byCmd(menuFor({ key: "d2", kind: "Deployment", name: "web", restart: "deployment is paused" }, undefined))["object.restart"]!.disabled).toBe("deployment is paused");
    expect(byCmd(menuFor({ key: "d1", kind: "Deployment", name: "web" }, ro))["object.restart"]!.disabled).toBe("read-only context");

    const prod = byCmd(menuFor(pod, ro));
    expect(prod["object.delete"]!.disabled).toBe("read-only context");
    expect(prod["object.label"]!.disabled).toBe("read-only context");
    expect(prod["object.annotate"]!.disabled).toBe("read-only context");
    expect(prod["object.exec"]!.disabled).toBe("read-only context");
    expect(prod["object.opsPod"]!.disabled).toBe("read-only context");
    expect(prod["object.portForward"]!.disabled).toBeUndefined(); // doesn't change the cluster
    expect(prod["object.describe"]!.disabled).toBeUndefined();
  });

  it("shortcuts follow keybindings.yaml", () => {
    const { bindings } = mergeBindings(defaultBindings, [
      { key: "x", command: "object.exec", when: ["table"] },
      { key: "s", command: "none", when: ["table"] },
      { key: "d", command: "none", when: ["table"] },
    ]);
    const m = byCmd(menuFor(pod, undefined, bindings));
    expect(m["object.exec"]!.shortcut).toBe("x");
    expect(m["object.describe"]!.shortcut).toBeUndefined(); // unbound: still in the menu, without a hint
  });

  it("split variants are a hint on their entry, not entries of their own", () => {
    const m = byCmd(menuFor(pod, undefined));
    expect(m["object.editSplit"]).toBeUndefined();
    expect(m["object.edit"]).toMatchObject({ label: "edit YAML", shortcut: "e", split: "object.editSplit", splitShortcut: "⇧E" });
    expect(m["object.describe"]).toMatchObject({ label: "describe", shortcut: "d", splitShortcut: "⇧D" });
    expect(m["detail.open"]).toMatchObject({ label: "view YAML", shortcut: "⏎", splitShortcut: "⇧⏎" });
    expect(m["object.diff"]!.splitShortcut).toBeUndefined();
  });

  it("every object.* command is in the menu (new row actions must be added to the registry)", () => {
    // split variants are a hint on their entry (⇧⏎ in the menu)
    const inMenu = new Set(rowActions.flatMap((a) => (a.split ? [a.command, a.split] : [a.command])));
    const objectCmds = commandIds.filter((c) => c.startsWith("object.") && c !== "object.menu");
    expect(objectCmds.filter((c) => !inMenu.has(c))).toEqual([]);
  });

  it("every menu command is handled by the dispatcher", () => {
    for (const a of rowActions) expect(commandsSrc).toContain(`case "${a.command}"`);
  });
});

describe("diff entry", () => {
  const label = (r: RowInfo) => menuFor(r, undefined).find((i) => i.command === "object.diff")!.label;
  it("says how many changes recorded history steps through", () => {
    expect(label({ ...pod, changes: undefined })).toBe("diff last change");
    expect(label({ ...pod, changes: 1 })).toBe("diff last change");
    expect(label({ ...pod, changes: 7 })).toBe("diff changes (7)");
  });
});

describe("row actions menu with marked rows", () => {
  const marked: MarkedRow[] = [
    { key: "u1", kind: "Pod", name: "web-0", restart: "pod can't be restarted", logs: true },
    { key: "u3", kind: "Pod", name: "web-1", restart: "pod can't be restarted", logs: true },
    { key: "u2", kind: "ConfigMap", name: "cfg", restart: "configmap can't be restarted" },
  ];

  it("multi actions act on the marked rows they fit, the rest on the cursor row", () => {
    const m = byCmd(menuFor(cm, undefined, defaultBindings, marked));
    expect(m["object.delete"]).toMatchObject({ label: "delete 3…", multi: true, disabled: undefined });
    expect(m["object.label"]!.label).toBe("label 3…");
    expect(m["object.copyName"]!.label).toBe("copy 3 names");
    expect(m["object.copyCell"]).toMatchObject({ label: "copy cells of 3…", multi: true });
    // the cursor row is a config map, but two marked rows are pods
    expect(m["object.debug"]).toMatchObject({ label: "debug containers in 2 pods…", disabled: undefined });
    expect(m["object.scale"]!.disabled).toBe("none of the 3 marked fits");
    expect(m["object.restart"]!.disabled).toBe("none of the 3 marked fits");
    // logs: one tail over the marked rows with pods (the config map has none)
    expect(m["object.logs"]).toMatchObject({ label: "logs of 2…", multi: true, disabled: undefined });
    const workloads = byCmd(menuFor(cm, undefined, defaultBindings, [...marked, { key: "d1", kind: "Deployment", name: "web" }, { key: "s1", kind: "StatefulSet", name: "db" }]));
    expect(workloads["object.restart"]).toMatchObject({ label: "rollout restart 2…", multi: true, disabled: undefined });
    // single-row actions keep the cursor row's availability
    expect(m["object.exec"]).toMatchObject({ multi: false, disabled: "needs a pod, not configmap" });
    expect(m["object.describe"]).toMatchObject({ multi: false, disabled: undefined });
  });

  it("read-only contexts refuse the multi mutations too", () => {
    const m = byCmd(menuFor(pod, ro, defaultBindings, marked));
    expect(m["object.delete"]!.disabled).toBe("read-only context");
    expect(m["object.copyName"]!.disabled).toBeUndefined();
  });

  it("without marks nothing changes", () => {
    expect(menuFor(pod, undefined, defaultBindings, [])).toEqual(menuFor(pod, undefined));
  });
});
