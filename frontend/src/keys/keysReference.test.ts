import { describe, expect, it } from "vitest";
import { canonicalKey, commandIds, defaultBindings } from "./keymap";
import { entryLine, keysProblems, keysReference, keysStarter, yamlKey } from "./keysReference";

/** The entries of a reference or file: its flow mappings, parsed (keys and contexts are plain, commands are words). */
function entries(text: string) {
  return text
    .split("\n")
    .filter((l) => l.startsWith("- {"))
    .map((l) => {
      const m = /^- \{key: ("(?:[^"\\]|\\.)*"), command: ([\w.]+)(?:, when: \[([\w, ]+)\])?\}$/.exec(l);
      if (!m) throw new Error(`not an entry: ${l}`);
      return { key: JSON.parse(m[1]!) as string, command: m[2]!, when: m[3]?.split(", ") };
    });
}

describe("keybindings reference", () => {
  it("writes chords as keybindings.yaml does, and they read back the same", () => {
    expect(yamlKey("Meta+Shift+D")).toBe("cmd+shift+d");
    expect(yamlKey("Alt+Meta+ArrowLeft")).toBe("alt+cmd+left");
    expect(yamlKey("Ctrl+Escape")).toBe("ctrl+esc");
    expect(yamlKey("?")).toBe("?");
    expect(yamlKey("Meta+,")).toBe("cmd+,");
    for (const b of defaultBindings) expect(canonicalKey(yamlKey(b.key))).toBe(b.key);
  });

  it("lists every default binding once, each a valid entry that changes nothing", () => {
    const ref = keysReference();
    const got = entries(ref);
    expect(got).toHaveLength(defaultBindings.length);
    // as overrides, the reference reproduces the defaults: no problems
    expect(keysProblems(got)).toEqual([]);
    expect(ref).toContain("# ── panes");
    expect(ref).toContain('- {key: "cmd+d", command: pane.splitDown}');
    expect(ref).toContain('- {key: "alt+cmd+,", command: config.editKeys}');
  });

  it("names the commands without a default key", () => {
    const unbound = commandIds.filter((c) => !defaultBindings.some((b) => b.command === c));
    const line = keysReference().split("\n").at(-2)!;
    for (const c of unbound) expect(line).toContain(c);
  });

  it("quotes what YAML would misread", () => {
    expect(entryLine({ key: "Meta+K", command: "row.down", when: ["table", "detail"] })).toBe('- {key: "cmd+k", command: row.down, when: [table, detail]}');
  });

  it("reports unknown commands, keys and contexts by position, incomplete entries left to Go", () => {
    expect(
      keysProblems([
        { key: "", command: "row.down" },
        { key: "cmd+k", command: "row.dwn" },
        { key: "hyper+k", command: "row.down" },
        { key: "cmd+k", command: "row.down", when: ["tabel"] },
      ]),
    ).toEqual(['[1] (cmd+k): unknown command "row.dwn"', "[2] (hyper+k): invalid key", '[3] (cmd+k): unknown context "tabel"']);
  });

  it("starts a new file as a valid empty list", () => {
    expect(keysStarter.trim().endsWith("[]")).toBe(true);
  });
});
