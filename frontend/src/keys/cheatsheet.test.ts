import { describe, expect, it } from "vitest";
import { cheatsheet, listedCommands } from "./cheatsheet";
import { commandIds, defaultBindings, mergeBindings } from "./keymap";
// the dispatcher's source, to check the sheet's own command is handled
import commandsSrc from "../commands.ts?raw";

const flat = (sections = cheatsheet()) => Object.fromEntries(sections.flatMap((s) => s.entries.map((e) => [e.label, e])));

describe("cheat sheet", () => {
  it("shows every command of the keymap (a new command needs a section entry)", () => {
    const listed = new Set(listedCommands);
    expect(commandIds.filter((c) => !listed.has(c))).toEqual([]);
    expect(listedCommands.filter((c, i) => listedCommands.indexOf(c) !== i)).toEqual([]); // no command twice
  });

  it("pretty-prints the chords and pairs next/previous on one line", () => {
    const e = flat();
    expect(e["split down"]!.keys).toEqual(["⌘D"]);
    expect(e["next / previous pane"]!.keys).toEqual(["⌘]", "⌘["]);
    expect(e["first / last row"]!.keys).toEqual(["g", "⌥↑", "⇧G", "⌥↓"]);
    expect(e["this cheat sheet"]!.keys).toEqual(["?"]);
    expect(e["delete…"]!.keys).toEqual(["⌘⌫", "⌦"]);
  });

  it("lists both keys of a command bound in two contexts", () => {
    const e = flat();
    expect(e["close pane"]!.keys).toEqual(["⌃D", "⌘W"]);
    expect(e["close pane"]!.when).toEqual(["table", "detail", "menu", "help", "terminal"]);
    expect(e["describe"]!.keys).toEqual(["d", "⇧D"]);
  });

  it("collapses the nine tab jumps into a range", () => {
    expect(flat()["go to tab 1–9 (9 = last)"]!.keys).toEqual(["⌘1–⌘9"]);
  });

  it("names the contexts a key is scoped to; global bindings show none", () => {
    const e = flat();
    expect(e["split down"]!.when).toEqual([]);
    expect(e["toggle diff"]!.when).toEqual(["detail"]);
    expect(e["next / previous row"]!.when).toEqual(["table", "menu", "forwards"]);
  });

  it("deduplicates a chord bound to the same command in several contexts", () => {
    expect(flat()["close"]!.keys).toEqual(["esc"]); // detail, menu, forwards and help
  });

  it("follows keybindings.yaml and drops what the user unbound", () => {
    const { bindings } = mergeBindings(defaultBindings, [
      { key: "ctrl+k", command: "row.up", when: ["table"] },
      { key: "?", command: "none", when: ["table", "detail", "forwards", "menu", "help"] },
    ]);
    const e = flat(cheatsheet(bindings));
    expect(e["next / previous row"]!.keys).toContain("⌃K");
    expect(e["this cheat sheet"]).toBeUndefined();
  });

  it("is handled by the dispatcher", () => {
    expect(commandsSrc).toContain(`case "help.toggle"`);
  });
});
