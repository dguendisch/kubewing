import { describe, expect, it } from "vitest";
import { accelerator, menuSpec, type MenuItem } from "./appMenu";
import { defaultBindings, mergeBindings } from "./keymap";

const items = (bindings = defaultBindings) =>
  Object.fromEntries(menuSpec(bindings).flatMap((m) => m.items.filter((i): i is MenuItem => !!i).map((i) => [i.command, i])));

describe("native menu", () => {
  it("translates chords to Wails accelerators", () => {
    expect(accelerator("Meta+D")).toBe("CmdOrCtrl+d");
    expect(accelerator("Meta+Shift+D")).toBe("CmdOrCtrl+Shift+d");
    expect(accelerator("Alt+Meta+ArrowLeft")).toBe("OptionOrAlt+CmdOrCtrl+left");
    expect(accelerator("Meta+Shift+,")).toBe("CmdOrCtrl+Shift+,");
    expect(accelerator("Meta+]")).toBe("CmdOrCtrl+]");
    expect(accelerator("Meta++")).toBe("CmdOrCtrl+plus");
    expect(accelerator("Meta+Backspace")).toBe("CmdOrCtrl+backspace");
  });

  it("gives global ⌘ chords a native key equivalent", () => {
    const i = items();
    expect(i["pane.splitDown"]!.accelerator).toBe("CmdOrCtrl+d");
    expect(i["tab.new"]!.accelerator).toBe("CmdOrCtrl+t");
    // ⌘W is the app's close tab, never a native "Close Window"
    expect(i["tab.close"]!.accelerator).toBe("CmdOrCtrl+w");
    expect(i["tab.goto9"]!.accelerator).toBe("CmdOrCtrl+9");
    expect(i["portforward.list"]!.accelerator).toBe("OptionOrAlt+CmdOrCtrl+p");
    expect(i["pane.toggleMaximize"]!.accelerator).toBe("CmdOrCtrl+Shift+return");
  });

  it("names scoped and plain keys in the label instead (natively they'd fire in text fields)", () => {
    const i = items();
    // ⌘← is line start in the filter bar: the history keys are named, not native
    expect(i["history.back"]).toEqual({ label: "Back  (⌘←)", command: "history.back" });
    // ⌘⇧[ is global, so it is a native key equivalent
    expect(i["tab.prev"]!.accelerator).toBe("CmdOrCtrl+Shift+[");
    expect(i["object.describe"]).toEqual({ label: "Describe  (d)", command: "object.describe" });
    // ⌘C is the native copy in fields, Monaco and terminals
    expect(i["object.copyName"]).toEqual({ label: "Copy Name  (⌘C)", command: "object.copyName" });
    expect(i["filter.focus"]!.accelerator).toBeUndefined(); // ⌘F is Monaco's find in the detail view
  });

  it("follows keybindings.yaml: rebound, unbound", () => {
    const { bindings } = mergeBindings(defaultBindings, [
      { key: "cmd+shift+t", command: "tab.new" },
      { key: "cmd+d", command: "none" },
    ]);
    const i = items(bindings);
    expect(i["tab.new"]!.accelerator).toBe("CmdOrCtrl+Shift+t");
    expect(i["pane.splitDown"]).toEqual({ label: "Split Down", command: "pane.splitDown" });
  });

  it("never takes a chord another context binds to something else", () => {
    // a global ⌘K plus a table-only ⌘K: natively ⌘K would also fire in the table
    const { bindings } = mergeBindings(defaultBindings, [
      { key: "cmd+k", command: "tab.new" },
      { key: "cmd+k", command: "object.describe", when: ["table"] },
    ]);
    expect(items(bindings)["tab.new"]!.accelerator).toBe("CmdOrCtrl+t");
  });

  it("assigns no accelerator twice", () => {
    const accels = menuSpec().flatMap((m) => m.items.flatMap((i) => (i?.accelerator ? [i.accelerator] : [])));
    expect(accels.filter((a, i) => accels.indexOf(a) !== i)).toEqual([]);
  });
});
