/**
 * keybindings.yaml for the settings editor (Settings ▸ Keyboard Shortcuts…):
 * the reference beside it (every default binding, in the cheat sheet's
 * sections, written as an entry would be), the starter of a new file, and
 * the problems an entry list has. Pure: the keymap is the frontend's, so Go
 * only reads and writes the file.
 */
import { cheatsheetLayout } from "./cheatsheet";
import { commandIds, defaultBindings, focusContexts, mergeBindings, type Binding, type UserBinding } from "./keymap";

/** A canonical chord ("Alt+Meta+Shift+D") as keybindings.yaml writes it ("alt+cmd+shift+d"). */
export function yamlKey(key: string): string {
  const parts = key.split("+");
  // "Meta++": the key is "+"
  let k = parts.pop()!;
  if (k === "" && key.endsWith("+")) {
    parts.pop();
    k = "+";
  }
  const mods: Record<string, string> = { Meta: "cmd", Ctrl: "ctrl", Alt: "alt", Shift: "shift" };
  const names: Record<string, string> = { Escape: "esc", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  const name = names[k] ?? k.toLowerCase();
  return [...parts.map((m) => mods[m] ?? m.toLowerCase()), name].join("+");
}

/** A YAML flow scalar: quoted unless it's a plain word (YAML 1.1 reads y/n/on/off as booleans). */
const scalar = (v: string) => (/^[A-Za-z][\w.-]*$/.test(v) && !/^(y|n|yes|no|on|off|true|false|null)$/i.test(v) ? v : JSON.stringify(v));

/** One entry as a flow mapping: {key: "cmd+d", command: pane.splitDown, when: [table]}. */
export function entryLine(b: Binding): string {
  const when = b.when?.length ? `, when: [${b.when.join(", ")}]` : "";
  return `- {key: ${JSON.stringify(yamlKey(b.key))}, command: ${scalar(b.command)}${when}}`;
}

const header = `# Every default key binding, by section, as a keybindings.yaml entry would write it.
# An entry overrides the defaults of its key in its contexts (every context without "when");
# command: none unbinds the key. Keys: cmd / ctrl / alt (opt) / shift joined with "+".
# Contexts: ${focusContexts.join(", ")}.
`;

/** The reference: every default binding under its cheat sheet section, then the ones no section lists. */
export function keysReference(bindings: Binding[] = defaultBindings): string {
  const out: string[] = [header];
  const seen = new Set<Binding>();
  for (const s of cheatsheetLayout) {
    const lines: string[] = [];
    for (const r of s.rows) {
      const own = bindings.filter((b) => r.commands.includes(b.command) && !seen.has(b) && (!r.in || !b.when?.length || b.when.includes(r.in)));
      if (!own.length) continue;
      lines.push(`# ${r.label}`);
      for (const b of own) {
        seen.add(b);
        lines.push(entryLine(b));
      }
    }
    if (lines.length) out.push(`\n# ── ${s.title} ${"─".repeat(Math.max(3, 60 - s.title.length))}\n`, lines.join("\n") + "\n");
  }
  const rest = bindings.filter((b) => !seen.has(b));
  if (rest.length) out.push("\n# ── other ───\n", rest.map(entryLine).join("\n") + "\n");
  out.push(`\n# ── commands without a default key ───\n# ${commandIds.filter((c) => !bindings.some((b) => b.command === c)).join(", ") || "none"}\n`);
  return out.join("");
}

/** A new keybindings.yaml: an example, commented out, so it changes nothing. */
export const keysStarter = `# kubewing key bindings: an entry overrides the defaults of its key (see the reference beside).
# Uncomment a line (⌘/) to try it, ⌘S saves and applies.
# - {key: "cmd+k", command: row.down, when: [table]}
# - {key: "cmd+shift+d", command: none}
[]
`;

/**
 * The problems of keybindings.yaml's entries (as Go read them; Go reports
 * malformed YAML and incomplete entries itself), without the file name, as
 * the editor lists them.
 */
export function keysProblems(user: UserBinding[]): string[] {
  return mergeBindings(defaultBindings, user).errors.map((e) => e.replace(/^keybindings\.yaml(: |\[)/, (_, p: string) => (p === "[" ? "[" : "")));
}
