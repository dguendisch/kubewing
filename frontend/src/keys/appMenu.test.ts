import { describe, expect, it } from "vitest";
import { accelerator, APP_MENU, menuSpec, type MenuItem } from "./appMenu";
import { defaultBindings, mergeBindings } from "./keymap";

/** Every command item, submenus' too. */
const flat = (items: (MenuItem | null)[]): MenuItem[] => items.flatMap((i) => (!i ? [] : i.items ? flat(i.items) : [i]));
const items = (bindings = defaultBindings) => Object.fromEntries(menuSpec(bindings).flatMap((m) => flat(m.items).map((i) => [i.command, i])));

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
    expect(i["source.reconnect"]).toEqual({ label: "Reconnect", command: "source.reconnect", accelerator: "CmdOrCtrl+Shift+r" });
  });

  it("only shows scoped and plain keys (natively they'd fire in text fields)", () => {
    const i = items();
    // ⌘← is line start in the filter bar: the history keys are shown, not native
    expect(i["history.back"]).toEqual({ label: "Back", command: "history.back", accelerator: "CmdOrCtrl+left", displayOnly: true });
    // ⌘⇧[ is global, so it is a native key equivalent
    expect(i["tab.prev"]).toEqual({ label: "Previous Tab", command: "tab.prev", accelerator: "CmdOrCtrl+Shift+[" });
    expect(i["object.describe"]).toEqual({ label: "Describe", command: "object.describe", accelerator: "d", displayOnly: true });
    // ⌘C is the native copy in fields, Monaco and terminals
    expect(i["table.copy"]).toEqual({ label: "Copy", command: "table.copy", accelerator: "CmdOrCtrl+c", displayOnly: true });
    expect(i["filter.focus"]!.displayOnly).toBe(true); // ⌘F is Monaco's find in the detail view
    // no key hint is left in a label
    const labels = menuSpec().flatMap((m) => flat(m.items).map((x) => x.label));
    expect(labels.filter((l) => / \(/.test(l))).toEqual([]);
  });

  it("puts the settings into the app menu, as macOS apps have them: a submenu with both files", () => {
    const app = menuSpec().find((m) => m.title === APP_MENU)!;
    expect(app.items).toEqual([
      {
        label: "Settings",
        items: [
          { label: "General…", command: "config.edit", accelerator: "CmdOrCtrl+," },
          { label: "Keyboard Shortcuts…", command: "config.editKeys", accelerator: "OptionOrAlt+CmdOrCtrl+," },
        ],
      },
    ]);
  });

  it("follows keybindings.yaml: rebound, unbound", () => {
    const { bindings } = mergeBindings(defaultBindings, [
      { key: "cmd+shift+t", command: "tab.new" },
      { key: "cmd+d", command: "none" },
    ]);
    const i = items(bindings);
    expect(i["tab.new"]!.accelerator).toBe("CmdOrCtrl+Shift+t");
    expect(i["pane.splitDown"]).toEqual({ label: "Split Down", command: "pane.splitDown" });
    // a key bound only in some context is shown, but stays the page's
    expect(i["object.describe"]!.displayOnly).toBe(true);
  });

  it("never takes a chord another context binds to something else", () => {
    // a global ⌘K plus a table-only ⌘K: natively ⌘K would also fire in the table
    const { bindings } = mergeBindings(defaultBindings, [
      { key: "cmd+k", command: "tab.new" },
      { key: "cmd+k", command: "object.describe", when: ["table"] },
    ]);
    expect(items(bindings)["tab.new"]!.accelerator).toBe("CmdOrCtrl+t");
  });

  it("assigns no working accelerator twice", () => {
    const accels = menuSpec().flatMap((m) => flat(m.items).flatMap((i) => (i.accelerator && !i.displayOnly ? [i.accelerator] : [])));
    expect(accels.filter((a, i) => accels.indexOf(a) !== i)).toEqual([]);
  });
});
