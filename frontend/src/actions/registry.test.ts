import { describe, expect, it } from "vitest";
import { commandIds, defaultBindings, mergeBindings } from "../keys/keymap";
import type { RowInfo, SafetyRule } from "../transport/types";
import { menuFor, prettyKey, rowActions } from "./registry";
// the dispatcher's source, to check every menu command is handled
import commandsSrc from "../commands.ts?raw";

const pod: RowInfo = { key: "u1", kind: "Pod", name: "web-0", namespace: "shop", pod: true, hasPrev: true, containers: ["app"], ports: [8080] };
const cm: RowInfo = { key: "u2", kind: "ConfigMap", name: "cfg", namespace: "shop" };
const ro: SafetyRule = { context: "prod", label: "PROD", readOnly: true, confirm: ["delete"] };

const byCmd = (items: ReturnType<typeof menuFor>) => Object.fromEntries(items.map((i) => [i.command, i]));

describe("row actions menu", () => {
  it("a pod offers everything, with its table shortcuts", () => {
    const m = byCmd(menuFor(pod, undefined));
    expect(Object.values(m).filter((i) => i.disabled)).toEqual([]);
    expect(m["object.describe"]!.shortcut).toBe("⇧D");
    expect(m["object.exec"]!.shortcut).toBe("s");
    expect(m["object.delete"]!.shortcut).toBe("⌃D");
    expect(m["object.portForward"]!.shortcut).toBe("⇧F");
    expect(m["detail.open"]!.shortcut).toBe("⏎");
  });

  it("explains why entries are unavailable", () => {
    const m = byCmd(menuFor(cm, undefined));
    expect(m["object.exec"]!.disabled).toBe("needs a pod, not configmap");
    expect(m["object.portForward"]!.disabled).toBe("needs a pod, not configmap");
    expect(m["object.diff"]!.disabled).toBe("no previous version since watch start");
    expect(m["object.describe"]!.disabled).toBeUndefined();

    const gone = byCmd(menuFor({ ...pod, deleted: true }, undefined));
    expect(gone["object.delete"]!.disabled).toBe("deleted");
    expect(gone["object.exec"]!.disabled).toBe("deleted");
    expect(gone["detail.open"]!.disabled).toBeUndefined(); // the last state is still viewable

    const prod = byCmd(menuFor(pod, ro));
    expect(prod["object.delete"]!.disabled).toBe("read-only context");
    expect(prod["object.exec"]!.disabled).toBe("read-only context");
    expect(prod["object.portForward"]!.disabled).toBeUndefined(); // doesn't change the cluster
    expect(prod["object.describe"]!.disabled).toBeUndefined();
  });

  it("shortcuts follow keybindings.yaml", () => {
    const { bindings } = mergeBindings(defaultBindings, [
      { key: "x", command: "object.exec", when: ["table"] },
      { key: "s", command: "none", when: ["table"] },
      { key: "Shift+D", command: "none", when: ["table", "detail"] },
    ]);
    const m = byCmd(menuFor(pod, undefined, bindings));
    expect(m["object.exec"]!.shortcut).toBe("x");
    expect(m["object.describe"]!.shortcut).toBeUndefined(); // unbound: still in the menu, without a hint
  });

  it("every object.* command is in the menu (new row actions must be added to the registry)", () => {
    const inMenu = new Set(rowActions.map((a) => a.command));
    const objectCmds = commandIds.filter((c) => c.startsWith("object.") && c !== "object.menu");
    expect(objectCmds.filter((c) => !inMenu.has(c))).toEqual([]);
  });

  it("every menu command is handled by the dispatcher", () => {
    for (const a of rowActions) expect(commandsSrc).toContain(`case "${a.command}"`);
  });

  it("pretty-prints chords", () => {
    expect(prettyKey("Alt+Meta+P")).toBe("⌥⌘P");
    expect(prettyKey("Meta+Enter")).toBe("⌘⏎");
    expect(prettyKey("J")).toBe("j");
    expect(prettyKey("Shift+G")).toBe("⇧G");
  });
});
