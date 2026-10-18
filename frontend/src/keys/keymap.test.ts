import { describe, expect, it } from "vitest";
import { canonicalKey, chord, collisions, commandIds, defaultBindings, mergeBindings, prettyKey, resolve, suppressedDefaults } from "./keymap";

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
    expect(chord({ key: "<", metaKey: true, shiftKey: true })).toBe("Meta+Shift+,");
  });

  it("uses the physical key when ⌥ (or another modifier) changes the character", () => {
    // what WKWebView/Chrome on macOS actually deliver
    expect(chord({ key: "π", code: "KeyP", metaKey: true, altKey: true })).toBe("Alt+Meta+P");
    expect(resolve(chord({ key: "π", code: "KeyP", metaKey: true, altKey: true }), "table")).toBe("portforward.list");
    expect(chord({ key: "∂", code: "KeyD", altKey: true })).toBe("Alt+D");
    expect(chord({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true })).toBe("Meta+Shift+]");
    expect(chord({ key: "<", code: "Comma", metaKey: true, shiftKey: true })).toBe("Meta+Shift+,");
    expect(chord({ key: "!", code: "Digit1", metaKey: true, shiftKey: true })).toBe("Meta+Shift+1");
    expect(chord({ key: "\u0004", code: "KeyD", ctrlKey: true })).toBe("Ctrl+D");
    // arrows and named keys are unaffected
    expect(chord({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true, altKey: true })).toBe("Alt+Meta+ArrowLeft");
    // without modifiers the typed character counts (layouts where / is elsewhere)
    expect(chord({ key: "/", code: "Digit7", shiftKey: true })).toBe("Shift+/");
    expect(chord({ key: "j", code: "KeyJ" })).toBe("J");
    expect(resolve(chord({ key: "<", metaKey: true, shiftKey: true }), "table")).toBe("config.reload");
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
    expect(resolve("Meta+F", "table")).toBe("filter.focus");
    expect(resolve("Meta+F", "detail")).toBeUndefined(); // Monaco's find
    expect(resolve("Ctrl+D", "table")).toBe("object.delete");
    expect(resolve("Ctrl+D", "filter")).toBeUndefined(); // forward-delete in inputs
    expect(resolve("Escape", "confirm")).toBe("confirm.cancel");
    expect(resolve("Enter", "confirm")).toBeUndefined(); // submits the confirm form (strict: only once typed)
    expect(resolve("?", "table")).toBe("help.toggle");
    expect(resolve("?", "help")).toBe("help.toggle"); // toggles back off
    expect(resolve("Escape", "help")).toBe("detail.close");
    expect(resolve("?", "filter")).toBeUndefined(); // typing a question mark into the filter
    expect(resolve("?", "confirm")).toBeUndefined();
  });
});

describe("terminal focus", () => {
  it("only ⌘ chords and ⌃⇥ reach the app; everything else goes to the shell", () => {
    expect(resolve("Meta+D", "terminal")).toBe("pane.splitDown");
    expect(resolve("Meta+W", "terminal")).toBe("pane.close");
    expect(resolve("Alt+Meta+ArrowLeft", "terminal")).toBe("pane.focusLeft");
    expect(resolve("Ctrl+Tab", "terminal")).toBe("tab.mruNext");
    expect(resolve("Ctrl+Shift+Tab", "terminal")).toBe("tab.mruPrev");
    for (const k of ["Ctrl+D", "Ctrl+C", "Escape", "J", "/", "Enter", "Alt+ArrowUp", "Ctrl+Escape"]) expect(resolve(k, "terminal")).toBeUndefined();
  });
  it("user bindings can't steal shell keys in a terminal either", () => {
    const { bindings } = mergeBindings(defaultBindings, [{ key: "ctrl+c", command: "pane.close" }]);
    expect(resolve("Ctrl+C", "table", bindings)).toBe("pane.close");
    expect(resolve("Ctrl+C", "terminal", bindings)).toBeUndefined();
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
    // Meta+F is ours (Monaco's find in the detail view); the rest must not be bound to a command by accident
    // (that would make suppression depend on focus).
    const bound = new Set(defaultBindings.map((b) => b.key));
    expect(suppressedDefaults.filter((k) => bound.has(k))).toEqual(["Meta+F"]);
  });
  it("pretty-prints chords", () => {
    expect(prettyKey("Alt+Meta+P")).toBe("⌥⌘P");
    expect(prettyKey("Meta+Enter")).toBe("⌘⏎");
    expect(prettyKey("J")).toBe("j");
    expect(prettyKey("Shift+G")).toBe("⇧G");
    expect(prettyKey("?")).toBe("?");
  });
});

describe("user keybindings", () => {
  it("canonicalizes user-written keys", () => {
    expect(canonicalKey("cmd+shift+d")).toBe("Meta+Shift+D");
    expect(canonicalKey("Shift+Meta+D")).toBe("Meta+Shift+D");
    expect(canonicalKey("opt+up")).toBe("Alt+ArrowUp");
    expect(canonicalKey("ctrl+esc")).toBe("Ctrl+Escape");
    expect(canonicalKey("j")).toBe("J");
    expect(canonicalKey("hyper+j")).toBeUndefined();
    expect(canonicalKey("cmd+")).toBeUndefined();
  });

  it("a global user binding replaces the key everywhere", () => {
    const { bindings, errors } = mergeBindings(defaultBindings, [{ key: "cmd+d", command: "tab.new" }]);
    expect(errors).toEqual([]);
    expect(resolve("Meta+D", "table", bindings)).toBe("tab.new");
    expect(resolve("Meta+D", "detail", bindings)).toBe("tab.new");
    expect(collisions(bindings)).toEqual([]);
  });

  it("a scoped user binding only replaces the key in its contexts", () => {
    const { bindings } = mergeBindings(defaultBindings, [{ key: "Escape", command: "detail.toggleDiff", when: ["detail"] }]);
    expect(resolve("Escape", "detail", bindings)).toBe("detail.toggleDiff");
    expect(resolve("Escape", "filter", bindings)).toBe("filter.blur");
    expect(collisions(bindings)).toEqual([]);
  });

  it("a scoped binding on a global key leaves the global default elsewhere", () => {
    const { bindings } = mergeBindings(defaultBindings, [{ key: "Meta+D", command: "row.down", when: ["table"] }]);
    expect(resolve("Meta+D", "table", bindings)).toBe("row.down");
    expect(resolve("Meta+D", "filter", bindings)).toBe("pane.splitDown");
  });

  it("none unbinds", () => {
    const { bindings } = mergeBindings(defaultBindings, [{ key: "j", command: "none", when: ["table"] }]);
    expect(resolve("J", "table", bindings)).toBeUndefined();
    expect(resolve("K", "table", bindings)).toBe("row.up");
  });

  it("reports and skips invalid entries", () => {
    const { bindings, errors } = mergeBindings(defaultBindings, [
      { key: "hyper+x", command: "row.up" },
      { key: "x", command: "rm.rf" },
      { key: "x", command: "row.up", when: ["sidebar"] },
      { key: "Meta+K", command: "row.up", when: ["table"] },
      { key: "Meta+K", command: "row.down", when: ["table"] },
    ]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("invalid key");
    expect(errors[1]).toContain('unknown command "rm.rf"');
    expect(errors[2]).toContain('unknown context "sidebar"');
    expect(errors[3]).toContain("Meta+K@table");
    expect(resolve("X", "table", bindings)).toBeUndefined();
  });

  it("every default command is a known command id", () => {
    const known = new Set<string>(commandIds);
    expect(defaultBindings.filter((b) => !known.has(b.command))).toEqual([]);
  });
});
