/**
 * Keymap resolution: (key chord, focus context) → command id. Pure.
 *
 * Every key path (JS keydown, native menu accelerator) resolves through
 * resolve() into the single command dispatcher (src/commands.ts).
 */
export type FocusContext = "table" | "filter" | "detail" | "palette" | "dialog" | "switcher";

export type CommandId =
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.close"
  | "pane.focusNext"
  | "pane.focusPrev"
  | "pane.focusLeft"
  | "pane.focusRight"
  | "pane.focusUp"
  | "pane.focusDown"
  | "tab.new"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | `tab.goto${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | "tab.mruNext"
  | "tab.mruPrev"
  | "tab.switcherCommit"
  | "tab.switcherCancel"
  | "filter.focus"
  | "filter.blur"
  | "row.down"
  | "row.up"
  | "row.pageDown"
  | "row.pageUp"
  | "row.first"
  | "row.last"
  | "detail.open"
  | "detail.close"
  | "detail.toggleDiff"
  | "source.open";

export interface Binding {
  key: string; // canonical chord, e.g. "Meta+Shift+D"
  command: CommandId;
  /** Contexts the binding is active in; empty = global. */
  when?: FocusContext[];
}

export const defaultBindings: Binding[] = [
  // deliberately swapped vs. iTerm: ⌘D stacks, ⌘⇧D goes side by side
  { key: "Meta+D", command: "pane.splitDown" },
  { key: "Meta+Shift+D", command: "pane.splitRight" },
  { key: "Meta+W", command: "pane.close" },
  { key: "Meta+]", command: "pane.focusNext" },
  { key: "Meta+[", command: "pane.focusPrev" },
  { key: "Alt+Meta+ArrowLeft", command: "pane.focusLeft" },
  { key: "Alt+Meta+ArrowRight", command: "pane.focusRight" },
  { key: "Alt+Meta+ArrowUp", command: "pane.focusUp" },
  { key: "Alt+Meta+ArrowDown", command: "pane.focusDown" },
  { key: "Meta+T", command: "tab.new" },
  { key: "Meta+Shift+W", command: "tab.close" },
  { key: "Meta+Shift+]", command: "tab.next" },
  { key: "Meta+Shift+[", command: "tab.prev" },
  // ⌘1–⌘8 go to that tab, ⌘9 to the last one (browser/iTerm convention)
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n): Binding => ({ key: `Meta+${n}`, command: `tab.goto${n}` })),
  // MRU switching; releasing Ctrl commits (handled on keyup in useKeys)
  { key: "Ctrl+Tab", command: "tab.mruNext" },
  { key: "Ctrl+Shift+Tab", command: "tab.mruPrev" },
  // ⌃ is usually still held while browsing the switcher
  { key: "Escape", command: "tab.switcherCancel", when: ["switcher"] },
  { key: "Ctrl+Escape", command: "tab.switcherCancel", when: ["switcher"] },
  { key: "Enter", command: "tab.switcherCommit", when: ["switcher"] },
  { key: "Ctrl+Enter", command: "tab.switcherCommit", when: ["switcher"] },
  { key: "Meta+O", command: "source.open" },
  { key: "/", command: "filter.focus", when: ["table"] },
  { key: "Meta+F", command: "filter.focus" },
  { key: "Escape", command: "filter.blur", when: ["filter"] },
  { key: "Escape", command: "detail.close", when: ["detail"] },
  { key: "J", command: "row.down", when: ["table"] },
  { key: "ArrowDown", command: "row.down", when: ["table"] },
  { key: "K", command: "row.up", when: ["table"] },
  { key: "ArrowUp", command: "row.up", when: ["table"] },
  { key: "PageDown", command: "row.pageDown", when: ["table"] },
  { key: "PageUp", command: "row.pageUp", when: ["table"] },
  { key: "G", command: "row.first", when: ["table"] },
  { key: "Alt+ArrowUp", command: "row.first", when: ["table"] },
  { key: "Shift+G", command: "row.last", when: ["table"] },
  { key: "Alt+ArrowDown", command: "row.last", when: ["table"] },
  { key: "Enter", command: "detail.open", when: ["table"] },
  { key: "Y", command: "detail.open", when: ["table"] },
  { key: "D", command: "detail.toggleDiff", when: ["detail"] },
];

/**
 * Webview defaults that must never fire (print, find, reload, zoom...).
 * Checked by keymap.test.ts; the app prevents default for these.
 */
export const suppressedDefaults = ["Meta+P", "Meta+F", "Meta+R", "Meta+Shift+R", "Meta+=", "Meta+-", "Meta+0", "Meta+S"];

const modOrder = ["Ctrl", "Alt", "Meta", "Shift"] as const;

/** Canonicalizes a KeyboardEvent-like object into a chord string. */
export function chord(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): string {
  let key = e.key;
  if (key.length === 1) key = key.toUpperCase();
  if (key === " ") key = "Space";
  // Shift+] arrives as "}" on US layouts
  const shifted: Record<string, string> = { "}": "]", "{": "[", "+": "=", _: "-" };
  if (e.shiftKey && shifted[key]) key = shifted[key]!;
  const mods = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Meta: e.metaKey };
  const parts = modOrder.filter((m) => mods[m] && !(m === "Shift" && key === "?"));
  return [...parts, key].join("+");
}

/** Resolves a chord in a focus context; context-specific bindings win over global ones. */
export function resolve(key: string, focus: FocusContext, bindings: Binding[] = defaultBindings): CommandId | undefined {
  let global: CommandId | undefined;
  for (const b of bindings) {
    if (b.key !== key) continue;
    if (b.when?.includes(focus)) return b.command;
    if (!b.when?.length && global === undefined) global = b.command;
  }
  return global;
}

/** Returns duplicate (key, context) pairs; used by tests and config loading. */
export function collisions(bindings: Binding[]): string[] {
  const seen = new Map<string, CommandId>();
  const out: string[] = [];
  for (const b of bindings) {
    for (const ctx of b.when?.length ? b.when : ["*"]) {
      const id = `${b.key}@${ctx}`;
      const prev = seen.get(id);
      if (prev && prev !== b.command) out.push(`${id}: ${prev} vs ${b.command}`);
      seen.set(id, b.command);
    }
  }
  return out;
}
