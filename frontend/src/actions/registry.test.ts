import { describe, expect, it } from "vitest";
import { commandIds, defaultBindings, mergeBindings } from "../keys/keymap";
import type { RowInfo, SafetyRule } from "../transport/types";
import { menuFor, rowActions } from "./registry";
// the dispatcher's source, to check every menu command is handled
import commandsSrc from "../commands.ts?raw";

const pod: RowInfo = { key: "u1", kind: "Pod", name: "web-0", namespace: "shop", pod: true, logs: true, hasPrev: true, containers: ["app"], ports: [8080] };
const cm: RowInfo = { key: "u2", kind: "ConfigMap", name: "cfg", namespace: "shop" };
const ro: SafetyRule = { context: "prod", label: "PROD", readOnly: true, confirm: ["delete"] };

const byCmd = (items: ReturnType<typeof menuFor>) => Object.fromEntries(items.map((i) => [i.command, i]));

describe("row actions menu", () => {
  it("a pod offers everything, with its table shortcuts", () => {
    const m = byCmd(menuFor(pod, undefined));
    expect(Object.values(m).filter((i) => i.disabled)).toEqual([]);
    expect(m["object.describe"]!.shortcut).toBe("d");
    expect(m["object.exec"]!.shortcut).toBe("x");
    expect(m["object.edit"]!.shortcut).toBe("e");
    expect(m["object.delete"]!.shortcut).toBe("⌘⌫");
    expect(m["object.portForward"]!.shortcut).toBe("f");
    expect(m["detail.open"]!.shortcut).toBe("⏎");
  });

  it("explains why entries are unavailable", () => {
    const m = byCmd(menuFor(cm, undefined));
    expect(m["object.exec"]!.disabled).toBe("needs a pod, not configmap");
    expect(m["object.logs"]!.disabled).toBe("no pods to tail");
    expect(m["object.portForward"]!.disabled).toBe("needs a pod, not configmap");
    expect(m["object.opsPod"]!.disabled).toBe("needs a node or pod, not configmap");
    // a node row: everything pod-only is off, the ops pod is on
    const node = byCmd(menuFor({ key: "n1", kind: "Node", name: "n1" }, undefined));
    expect(node["object.opsPod"]!.disabled).toBeUndefined();
    expect(node["object.opsPod"]!.shortcut).toBe("⌥⌘O");
    expect(node["object.exec"]!.disabled).toBe("needs a pod, not node");
    expect(m["object.diff"]!.disabled).toBe("no change seen yet");
    expect(m["object.describe"]!.disabled).toBeUndefined();

    const gone = byCmd(menuFor({ ...pod, deleted: true }, undefined));
    expect(gone["object.delete"]!.disabled).toBe("deleted");
    expect(gone["object.exec"]!.disabled).toBe("deleted");
    expect(gone["detail.open"]!.disabled).toBeUndefined(); // the last state is still viewable

    const prod = byCmd(menuFor(pod, ro));
    expect(prod["object.delete"]!.disabled).toBe("read-only context");
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
    // object.events is an entry of the jump menu (jump to…), like the other places a pane can switch to
    const objectCmds = commandIds.filter((c) => c.startsWith("object.") && c !== "object.menu" && c !== "object.events");
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
