import { describe, expect, it } from "vitest";
import { canonicalKey, chord, collisions, commandIds, defaultBindings, fieldReserved, mergeBindings, keyContexts, prettyKey, resolve, resolveIn, suppressedDefaults } from "./keymap";

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
    // "!" needs ⇧ everywhere: it's just "!"; with ⌘ it's the physical key
    expect(chord({ key: "!", code: "Digit1", shiftKey: true })).toBe("!");
    expect(resolve(chord({ key: "!", code: "Digit1", shiftKey: true }), "detail")).toBe("filter.fromDetailNot");
    expect(resolve(chord({ key: "=", code: "Equal" }), "detail")).toBe("filter.fromDetail");
    expect(chord({ key: "j", code: "KeyJ" })).toBe("J");
    expect(resolve(chord({ key: "<", metaKey: true, shiftKey: true }), "table")).toBe("config.reload");
    // ⌘⇧R reconnects from anywhere, also a shell or a log pane
    expect(resolve(chord({ key: "R", metaKey: true, shiftKey: true }), "terminal")).toBe("source.reconnect");
    expect(resolve(chord({ key: "R", metaKey: true, shiftKey: true }), "filter")).toBe("source.reconnect");
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
      expect(resolve("Ctrl+Meta+ArrowLeft", ctx)).toBe("pane.resizeLeft");
      expect(resolve("Ctrl+Meta+ArrowUp", ctx)).toBe("pane.resizeUp");
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
    expect(resolve("Ctrl+D", "table")).toBe("pane.close");
    expect(resolve("Ctrl+D", "filter")).toBeUndefined(); // forward-delete in inputs
    expect(resolve("X", "forwards")).toBe("portforward.stop"); // x or ⌫ stops, as in the f dialog
    expect(resolve("Backspace", "forwards")).toBe("portforward.stop");
    expect(resolve("Ctrl+D", "forwards")).toBeUndefined();
    expect(resolve("J", "forwards")).toBeUndefined(); // arrows only
    expect(resolve("ArrowDown", "forwards")).toBe("row.down");
    expect(resolve("Meta+W", "table")).toBe("tab.close");
    expect(resolve("Meta+W", "terminal")).toBe("tab.close"); // the same in every pane kind
    expect(resolve("Ctrl+D", "terminal")).toBeUndefined(); // the shell's EOF
    expect(resolve("Ctrl+D", "ended")).toBe("pane.close"); // …until the shell has ended
    expect(resolve("Ctrl+D", "logs")).toBe("pane.close"); // a log pane has no shell to take ⌃D
    // a local terminal on the pane's context, from tables, object views, log panes; ⌃T stays the shell's in a terminal
    for (const ctx of ["table", "detail", "logs", "ended"] as const) {
      expect(resolve("Ctrl+T", ctx)).toBe("terminal.splitDown");
      expect(resolve("Ctrl+Shift+T", ctx)).toBe("terminal.splitRight");
    }
    expect(resolve("Ctrl+T", "terminal")).toBeUndefined();
    expect(resolve("Ctrl+Shift+T", "terminal")).toBeUndefined();
    expect(resolve("Ctrl+T", "filter")).toBeUndefined(); // transpose in text fields
    // the log view scrolls with the usual keys; ⏎ jumps to the latest line
    expect(resolve("ArrowDown", "logs")).toBe("logs.lineDown");
    expect(resolve("PageUp", "logs")).toBe("logs.pageUp");
    expect(resolve("Home", "logs")).toBe("logs.top");
    expect(resolve("End", "logs")).toBe("logs.bottom");
    expect(resolve("Enter", "logs")).toBe("logs.bottom");
    expect(resolve("Enter", "logsfind")).toBe("logs.findNext"); // not while finding
    expect(resolve("Home", "logsfilter")).toBeUndefined(); // caret movement in the grep field
    expect(resolve("Meta+F", "logsfilter")).toBe("logs.find"); // find within what the grep shows
    expect(resolve("Enter", "logsfilter")).toBe("logs.blurFilter"); // ⏎ goes back to the lines, as Esc
    expect(resolve("Meta+W", "ended")).toBe("tab.close");
    expect(resolve("J", "ended")).toBeUndefined(); // no table to move in
    expect(resolve("Meta+Shift+]", "table")).toBe("tab.next");
    expect(resolve("Meta+Shift+[", "table")).toBe("tab.prev");
    expect(resolve("Meta+ArrowRight", "filter")).toBeUndefined(); // start/end of line in inputs
    expect(resolve("D", "table")).toBe("object.describe");
    expect(resolve("D", "detail")).toBe("detail.toggleDiff"); // describe keeps ⇧D in the detail view
    expect(resolve("Shift+D", "detail")).toBe("object.describe");
    expect(resolve("F", "table")).toBe("object.portForward");
    expect(resolve("Meta+Backspace", "table")).toBe("object.delete");
    expect(resolve("Delete", "table")).toBe("object.delete");
    expect(resolve("Meta+Backspace", "filter")).toBeUndefined(); // deleting a word in the filter
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
  it("only ⌘ chords, ⌃⇥ and ⌃⇧D reach the app; everything else goes to the shell", () => {
    expect(resolve("Meta+D", "terminal")).toBe("pane.splitDown");
    expect(resolve("Meta+W", "terminal")).toBe("tab.close");
    expect(resolve("Meta+Shift+]", "terminal")).toBe("tab.next");
    expect(resolve("Alt+Meta+ArrowLeft", "terminal")).toBe("pane.focusLeft");
    expect(resolve("Ctrl+Meta+ArrowRight", "terminal")).toBe("pane.resizeRight");
    expect(resolve("Ctrl+Tab", "terminal")).toBe("tab.mruNext");
    expect(resolve("Ctrl+Shift+Tab", "terminal")).toBe("tab.mruPrev");
    expect(resolve("Ctrl+Shift+D", "terminal")).toBe("pane.close"); // a shell that ignores ⌃D
    expect(resolve("Ctrl+Shift+D", "table")).toBe("pane.close");
    expect(resolve("Ctrl+Shift+D", "filter")).toBeUndefined();
    for (const k of ["Ctrl+D", "Ctrl+C", "Escape", "J", "/", "Enter", "Alt+ArrowUp", "Ctrl+Escape"]) expect(resolve(k, "terminal")).toBeUndefined();
  });
  it("user bindings can't steal shell keys in a terminal either", () => {
    const { bindings } = mergeBindings(defaultBindings, [{ key: "ctrl+c", command: "pane.close" }]);
    expect(resolve("Ctrl+C", "table", bindings)).toBe("pane.close");
    expect(resolve("Ctrl+C", "terminal", bindings)).toBeUndefined();
  });
});

describe("edit", () => {
  it("e edits (table and YAML view), x execs; the editor keeps its keys", () => {
    expect(resolve("E", "table")).toBe("object.edit");
    expect(resolve("E", "detail")).toBe("object.edit");
    expect(resolve("X", "table")).toBe("object.exec");
    expect(resolve("X", "forwards")).toBe("portforward.stop");
    for (const k of ["D", "J", "X", "E", "Y", "=", "?", "Enter", "Ctrl+D", "Shift+D", "Meta+ArrowLeft"]) expect(resolve(k, "edit")).toBeUndefined();
    expect(resolve("Escape", "edit")).toBe("edit.back");
    expect(resolve("Meta+S", "edit")).toBe("edit.submit");
    expect(resolve("Meta+Enter", "edit")).toBe("edit.submit");
  });
  it("the editor and its preview are modal: no global keys that change anything behind them", () => {
    for (const ctx of ["edit", "editpreview"] as const)
      for (const k of ["Meta+D", "Meta+Shift+D", "Meta+W", "Meta+T", "Meta+O", "Meta+Shift+O", "Meta+I"]) expect(resolve(k, ctx)).toBeUndefined();
    expect(resolve("Meta+D", "table")).toBe("pane.splitDown");
    expect(resolve("Meta+D", "detail")).toBe("pane.splitDown");
  });
  it("from the editor the focus can move to another pane or tab: the edit stays in its pane", () => {
    for (const ctx of ["edit", "editpreview"] as const) {
      expect(resolve("Alt+Meta+ArrowLeft", ctx)).toBe("pane.focusLeft");
      expect(resolve("Meta+]", ctx)).toBeUndefined(); // the editor's indent
      expect(resolve("Meta+1", ctx)).toBe("tab.goto1");
      expect(resolve("Ctrl+Tab", ctx)).toBe("tab.mruNext");
      expect(resolve("Meta+Shift+]", ctx)).toBe("tab.next");
      expect(resolve("Meta+Shift+Enter", ctx)).toBe("pane.toggleMaximize");
      expect(resolve("Ctrl+Meta+ArrowDown", ctx)).toBe("pane.resizeDown");
    }
  });
  it("the preview steps through changes and applies with ⏎", () => {
    expect(resolve("J", "editpreview")).toBe("diff.next");
    expect(resolve("K", "editpreview")).toBe("diff.prev");
    expect(resolve("Enter", "editpreview")).toBe("edit.submit");
    expect(resolve("Escape", "editpreview")).toBe("edit.back");
    expect(resolve("D", "editpreview")).toBeUndefined();
  });
});

describe("Monaco find field", () => {
  it("keeps typed keys (d, j, =, ⌃D, ⌘←) and lets ⌘ chords and ⌃⇥ through", () => {
    for (const k of ["D", "Shift+D", "J", "K", "Y", "W", "R", "=", "!", "?", "Ctrl+D", "Ctrl+Shift+D", "Enter", "Meta+ArrowLeft", "Meta+ArrowRight"]) expect(fieldReserved(k)).toBe(true);
    for (const k of ["Meta+W", "Meta+D", "Meta+]", "Meta+1", "Alt+Meta+ArrowLeft", "Ctrl+Tab", "Ctrl+Shift+Tab"]) expect(fieldReserved(k)).toBe(false);
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
    // Meta+F ours (Monaco's find in the detail view), Meta+R a listing's refresh, Meta+Shift+R
    // the reconnect, Meta+S the editor's preview/apply, Meta+= / Meta+- / Meta+0 the font zoom; the rest must not be bound to a command by accident (that would make
    // suppression depend on focus).
    const bound = new Set(defaultBindings.map((b) => b.key));
    expect(suppressedDefaults.filter((k) => bound.has(k))).toEqual(["Meta+F", "Meta+R", "Meta+Shift+R", "Meta+=", "Meta+-", "Meta+0", "Meta+S"]);
  });
  it("pretty-prints chords", () => {
    expect(prettyKey("Alt+Meta+P")).toBe("⌥⌘P");
    expect(prettyKey("Meta+Enter")).toBe("⌘⏎");
    expect(prettyKey("J")).toBe("j");
    expect(prettyKey("Shift+G")).toBe("⇧G");
    expect(prettyKey("Meta+Backspace")).toBe("⌘⌫");
    expect(prettyKey("Delete")).toBe("⌦");
    expect(prettyKey("?")).toBe("?");
  });
});

describe("user keybindings", () => {
  it("canonicalizes user-written keys", () => {
    expect(canonicalKey("cmd+shift+d")).toBe("Meta+Shift+D");
    expect(canonicalKey("Shift+Meta+D")).toBe("Meta+Shift+D");
    expect(canonicalKey("opt+up")).toBe("Alt+ArrowUp");
    expect(canonicalKey("ctrl+esc")).toBe("Ctrl+Escape");
    expect(canonicalKey("cmd+backspace")).toBe("Meta+Backspace");
    expect(canonicalKey("del")).toBe("Delete");
    expect(canonicalKey("shift+home")).toBe("Shift+Home");
    expect(canonicalKey("end")).toBe("End");
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
      { key: "hyper+q", command: "row.up" },
      { key: "q", command: "rm.rf" },
      { key: "q", command: "row.up", when: ["sidebar"] },
      { key: "Meta+K", command: "row.up", when: ["table"] },
      { key: "Meta+K", command: "row.down", when: ["table"] },
    ]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("invalid key");
    expect(errors[1]).toContain('unknown command "rm.rf"');
    expect(errors[2]).toContain('unknown context "sidebar"');
    expect(errors[3]).toContain("Meta+K@table");
    expect(resolve("Q", "table", bindings)).toBeUndefined();
  });

  it("every default command is a known command id", () => {
    const known = new Set<string>(commandIds);
    expect(defaultBindings.filter((b) => !known.has(b.command))).toEqual([]);
  });
});

describe("jump to (⌘J), history (⌘← / ⌘→), tabs (⌘⇧[ / ⌘⇧])", () => {
  it("⌘J opens the jump menu from the table and the detail view", () => {
    expect(resolve("Meta+J", "table")).toBe("object.jump");
    expect(resolve("Meta+J", "detail")).toBe("object.jump");
    expect(resolve("U", "table")).toBeUndefined();
    expect(resolve("Escape", "table")).toBe("table.clearSelection"); // a cell's text selection
    expect(resolve("Escape", "menu")).toBe("detail.close"); // the jump menu closes like the ⌘⏎ menu
    expect(resolve("Shift+Enter", "menu")).toBe("menu.runSplit");
    expect(resolve("Meta+Enter", "menu")).toBe("menu.runTab");
    // ⌘⇧P in ⌘O too: a cluster just opened has it open over it
    expect(resolve("Meta+Shift+P", "dialog")).toBe("cluster.otherPlane");
    expect(resolve("Enter", "menu")).toBe("menu.run");
    expect(resolve("J", "table")).toBe("row.down");
  });

  it("v shows the row's events from the table and the detail view; in fields it's text", () => {
    expect(resolve("V", "table")).toBe("object.events");
    expect(resolve("V", "detail")).toBe("object.events");
    for (const ctx of ["filter", "terminal", "edit", "menu"] as const) expect(resolve("V", ctx)).toBeUndefined();
  });

  it("⌘← / ⌘→ move through the jump history in the table; elsewhere they're the field's or nothing", () => {
    expect(resolve("Meta+ArrowLeft", "table")).toBe("history.back");
    expect(resolve("Meta+ArrowRight", "table")).toBe("history.forward");
    // start/end of line, in the YAML viewer (Monaco's), the editor and fields
    for (const ctx of ["detail", "filter", "edit", "menu", "terminal"] as const) {
      expect(resolve("Meta+ArrowLeft", ctx)).toBeUndefined();
      expect(resolve("Meta+ArrowRight", ctx)).toBeUndefined();
    }
  });

  it("⏎ shows the row's object in place, ⇧⏎ in a split; in an object view ⇧⏎ splits what it shows", () => {
    expect(resolve("Enter", "table")).toBe("detail.open");
    expect(resolve("Shift+Enter", "table")).toBe("detail.openSplit");
    expect(resolve("Shift+Enter", "detail")).toBe("detail.openSplit");
    expect(resolve("Escape", "detail")).toBe("detail.close");
    expect(resolve("Shift+Enter", "edit")).toBeUndefined(); // a newline in the editor
  });

  it("⌘⇧[ / ⌘⇧] cycle tabs from anywhere, also from a shell", () => {
    for (const ctx of ["table", "detail", "terminal", "filter", "menu"] as const) {
      expect(resolve("Meta+Shift+]", ctx)).toBe("tab.next");
      expect(resolve("Meta+Shift+[", ctx)).toBe("tab.prev");
    }
    // as macOS delivers them: ⇧] types "}"
    expect(resolve(chord({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }), "table")).toBe("tab.next");
    expect(resolve(chord({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }), "table")).toBe("tab.prev");
  });
});

describe("time-travel keys", () => {
  it("in the past the arrows move in time, the table keys still work", () => {
    const ctx = keyContexts("table", true);
    expect(resolveIn("ArrowLeft", ctx)).toBe("travel.prev");
    expect(resolveIn("Shift+ArrowRight", ctx)).toBe("travel.forward");
    expect(resolveIn("Escape", ctx)).toBe("travel.live");
    expect(resolveIn("J", ctx)).toBe("row.down");
    expect(resolveIn("Meta+D", ctx)).toBe("pane.splitDown"); // a global
  });

  it("the live table keeps its keys", () => {
    const ctx = keyContexts("table", false);
    expect(resolveIn("ArrowLeft", ctx)).toBeUndefined();
    expect(resolveIn("Escape", ctx)).toBe("table.clearSelection");
    expect(resolveIn("T", ctx)).toBe("travel.toggle");
    expect(keyContexts("detail", true)).toEqual(["detail"]);
  });
});
