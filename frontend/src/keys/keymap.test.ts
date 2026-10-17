import { describe, expect, it } from "vitest";
import { chord, collisions, defaultBindings, resolve, suppressedDefaults } from "./keymap";

describe("chord", () => {
  it("canonicalizes", () => {
    expect(chord({ key: "d", metaKey: true })).toBe("Meta+D");
    expect(chord({ key: "D", metaKey: true, shiftKey: true })).toBe("Meta+Shift+D");
    expect(chord({ key: "}", metaKey: true, shiftKey: true })).toBe("Meta+Shift+]");
    expect(chord({ key: "/" })).toBe("/");
    expect(chord({ key: "G", shiftKey: true })).toBe("Shift+G");
    expect(chord({ key: "ArrowLeft", metaKey: true, altKey: true })).toBe("Alt+Meta+ArrowLeft");
    expect(chord({ key: "Tab", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+Tab");
    expect(chord({ key: "ArrowUp", altKey: true })).toBe("Alt+ArrowUp");
  });
});

describe("resolve", () => {
  it("global bindings work from every context", () => {
    for (const ctx of ["table", "filter", "detail"] as const) {
      // swapped vs. iTerm on purpose: ⌘D stacks, ⌘⇧D side by side
      expect(resolve("Meta+D", ctx)).toBe("pane.splitDown");
      expect(resolve("Meta+Shift+D", ctx)).toBe("pane.splitRight");
      expect(resolve("Alt+Meta+ArrowLeft", ctx)).toBe("pane.focusLeft");
      expect(resolve("Alt+Meta+ArrowDown", ctx)).toBe("pane.focusDown");
      expect(resolve("Ctrl+Tab", ctx)).toBe("tab.mruNext");
      expect(resolve("Ctrl+Shift+Tab", ctx)).toBe("tab.mruPrev");
      expect(resolve("Meta+1", ctx)).toBe("tab.goto1");
      expect(resolve("Meta+9", ctx)).toBe("tab.goto9");
    }
  });
  it("context bindings are scoped", () => {
    expect(resolve("J", "table")).toBe("row.down");
    expect(resolve("J", "filter")).toBeUndefined(); // typing in the filter bar
    expect(resolve("Escape", "filter")).toBe("filter.blur");
    expect(resolve("Escape", "detail")).toBe("detail.close");
    expect(resolve("Alt+ArrowUp", "table")).toBe("row.first");
    expect(resolve("Alt+ArrowDown", "table")).toBe("row.last");
    expect(resolve("Alt+ArrowUp", "filter")).toBeUndefined(); // caret movement in inputs
    expect(resolve("Escape", "switcher")).toBe("tab.switcherCancel");
    expect(resolve("Ctrl+Escape", "switcher")).toBe("tab.switcherCancel"); // ⌃ still held
    expect(resolve("Ctrl+Tab", "switcher")).toBe("tab.mruNext"); // keeps stepping while ⌃ is held
  });
});

describe("default keymap", () => {
  it("has no collisions", () => {
    expect(collisions(defaultBindings)).toEqual([]);
  });
  it("detects collisions", () => {
    expect(collisions([...defaultBindings, { key: "J", command: "row.up", when: ["table"] }])).toHaveLength(1);
  });
  it("suppressed webview defaults are either bound or explicitly unbound", () => {
    // Meta+F is ours; the rest must not be bound to a command by accident
    // (that would make suppression depend on focus).
    const bound = new Set(defaultBindings.map((b) => b.key));
    expect(suppressedDefaults.filter((k) => bound.has(k))).toEqual(["Meta+F"]);
  });
});
