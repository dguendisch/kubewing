import { describe, expect, it } from "vitest";
import { chord, collisions, defaultBindings, resolve, suppressedDefaults } from "./keymap";

describe("chord", () => {
  it("canonicalizes", () => {
    expect(chord({ key: "d", metaKey: true })).toBe("Meta+D");
    expect(chord({ key: "D", metaKey: true, shiftKey: true })).toBe("Meta+Shift+D");
    expect(chord({ key: "}", metaKey: true, shiftKey: true })).toBe("Meta+Shift+]");
    expect(chord({ key: "/" })).toBe("/");
    expect(chord({ key: "G", shiftKey: true })).toBe("Shift+G");
  });
});

describe("resolve", () => {
  it("global bindings work from every context", () => {
    for (const ctx of ["table", "filter", "detail"] as const) {
      expect(resolve("Meta+D", ctx)).toBe("pane.splitRight");
      expect(resolve("Meta+Shift+D", ctx)).toBe("pane.splitDown");
    }
  });
  it("context bindings are scoped", () => {
    expect(resolve("J", "table")).toBe("row.down");
    expect(resolve("J", "filter")).toBeUndefined(); // typing in the filter bar
    expect(resolve("Escape", "filter")).toBe("filter.blur");
    expect(resolve("Escape", "detail")).toBe("detail.close");
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
