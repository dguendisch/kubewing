/**
 * Keymap resolution: (key chord, focus context) → command id. Pure.
 *
 * Every key path (JS keydown, native menu accelerator) resolves through
 * resolve() into the single command dispatcher (src/commands.ts).
 */
export const focusContexts = ["table", "filter", "detail", "palette", "dialog", "switcher", "confirm", "terminal", "forwards", "menu"] as const;
export type FocusContext = (typeof focusContexts)[number];

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
  | "detail.showYaml"
  | "source.open"
  | "config.reload"
  | "object.delete"
  | "object.diff"
  | "object.menu"
  | "menu.run"
  | "object.describe"
  | "object.exec"
  | "object.portForward"
  | "portforward.list"
  | "portforward.stop"
  | "confirm.accept"
  | "confirm.cancel";

/** Every command id, for validating user keybindings. */
export const commandIds: readonly CommandId[] = [
  "pane.splitRight", "pane.splitDown", "pane.close", "pane.focusNext", "pane.focusPrev",
  "pane.focusLeft", "pane.focusRight", "pane.focusUp", "pane.focusDown",
  "tab.new", "tab.close", "tab.next", "tab.prev",
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => `tab.goto${n}` as const),
  "tab.mruNext", "tab.mruPrev", "tab.switcherCommit", "tab.switcherCancel",
  "filter.focus", "filter.blur",
  "row.down", "row.up", "row.pageDown", "row.pageUp", "row.first", "row.last",
  "detail.open", "detail.close", "detail.toggleDiff", "detail.showYaml",
  "source.open", "config.reload",
  "object.delete", "object.diff", "object.menu", "menu.run", "object.describe", "object.exec", "object.portForward",
  "portforward.list", "portforward.stop", "confirm.accept", "confirm.cancel",
];

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
  { key: "Meta+Shift+,", command: "config.reload" },
  { key: "/", command: "filter.focus", when: ["table"] },
  // in the detail view ⌘F is Monaco's find
  { key: "Meta+F", command: "filter.focus", when: ["table", "filter"] },
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
  { key: "Y", command: "detail.showYaml", when: ["detail"] },
  // k9s convention; the safety model decides whether and how to confirm
  { key: "Ctrl+D", command: "object.delete", when: ["table"] },
  // context menu of the selected row (also right-click): every row action, generated from actions/registry.ts
  { key: "Meta+Enter", command: "object.menu", when: ["table"] },
  { key: "Escape", command: "detail.close", when: ["menu"] },
  { key: "J", command: "row.down", when: ["menu"] },
  { key: "ArrowDown", command: "row.down", when: ["menu"] },
  { key: "K", command: "row.up", when: ["menu"] },
  { key: "ArrowUp", command: "row.up", when: ["menu"] },
  { key: "Enter", command: "menu.run", when: ["menu"] },
  { key: "Shift+D", command: "object.describe", when: ["table", "detail"] },
  { key: "S", command: "object.exec", when: ["table"] },
  { key: "Shift+F", command: "object.portForward", when: ["table"] },
  { key: "Alt+Meta+P", command: "portforward.list" },
  { key: "Ctrl+D", command: "portforward.stop", when: ["forwards"] },
  { key: "Escape", command: "detail.close", when: ["forwards"] },
  { key: "J", command: "row.down", when: ["forwards"] },
  { key: "ArrowDown", command: "row.down", when: ["forwards"] },
  { key: "K", command: "row.up", when: ["forwards"] },
  { key: "ArrowUp", command: "row.up", when: ["forwards"] },
  { key: "Escape", command: "confirm.cancel", when: ["confirm"] },
];

/**
 * Webview defaults that must never fire (print, find, reload, zoom...).
 * Checked by keymap.test.ts; the app prevents default for these.
 */
export const suppressedDefaults = ["Meta+P", "Meta+F", "Meta+R", "Meta+Shift+R", "Meta+=", "Meta+-", "Meta+0", "Meta+S"];

const modOrder = ["Ctrl", "Alt", "Meta", "Shift"] as const;

/** Physical key (KeyboardEvent.code) → the key name used in chords. */
const codeKeys: Record<string, string> = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
};

function fromCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return codeKeys[code];
}

/**
 * Canonicalizes a KeyboardEvent-like object into a chord string.
 *
 * With a modifier held, letters, digits and punctuation come from the
 * physical key (e.code): on macOS ⌥ changes the character (⌥P types "π"),
 * and ⇧ does too ("}" for ⇧]), but ⌘⌥P must still be Alt+Meta+P. Without
 * modifiers (or with only ⇧) the typed character counts, so "/" and "?" work
 * on any layout.
 */
export function chord(e: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): string {
  let key = e.key;
  const physical = (e.metaKey || e.ctrlKey || e.altKey) && fromCode(e.code);
  if (physical) key = physical;
  else {
    if (key.length === 1) key = key.toUpperCase();
    // Shift+] arrives as "}" on US layouts (and no e.code in some synthetic events)
    const shifted: Record<string, string> = { "}": "]", "{": "[", "+": "=", _: "-", "<": ",", ">": "." };
    if (e.shiftKey && shifted[key]) key = shifted[key]!;
  }
  if (key === " ") key = "Space";
  const mods = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Meta: e.metaKey };
  const parts = modOrder.filter((m) => mods[m] && !(m === "Shift" && key === "?"));
  return [...parts, key].join("+");
}

/**
 * In a terminal every key belongs to the shell (⌃C, ⌃D, Esc, arrows …);
 * only ⌘ chords and ⌃⇥ MRU switching reach the app.
 */
export function terminalReserved(key: string): boolean {
  const mods = key.split("+").slice(0, -1);
  return !mods.includes("Meta") && !/^Ctrl(\+Shift)?\+Tab$/.test(key);
}

/** Resolves a chord in a focus context; context-specific bindings win over global ones. */
export function resolve(key: string, focus: FocusContext, bindings: Binding[] = defaultBindings): CommandId | undefined {
  if (focus === "terminal" && terminalReserved(key)) return undefined;
  let global: CommandId | undefined;
  for (const b of bindings) {
    if (b.key !== key) continue;
    if (b.when?.includes(focus)) return b.command;
    if (!b.when?.length && global === undefined) global = b.command;
  }
  return global;
}

/** A keybindings.yaml entry as loaded by Go; command "none" unbinds. */
export interface UserBinding {
  key: string;
  command: string;
  when?: string[];
}

/**
 * Merges user bindings over defaults: a user entry replaces every default
 * binding of the same key in the same contexts ("none" just removes them).
 * Invalid entries are skipped and reported. Pure.
 */
export function mergeBindings(defaults: Binding[], user: UserBinding[]): { bindings: Binding[]; errors: string[] } {
  const errors: string[] = [];
  const known = new Set<string>(commandIds);
  const contexts = new Set<string>(focusContexts);
  let bindings = [...defaults];
  const added: Binding[] = [];
  user.forEach((u, i) => {
    const where = `keybindings.yaml[${i}] (${u.key})`;
    const key = canonicalKey(u.key);
    if (!key) return errors.push(`${where}: invalid key`);
    if (u.command !== "none" && !known.has(u.command)) return errors.push(`${where}: unknown command "${u.command}"`);
    const bad = (u.when ?? []).filter((w) => !contexts.has(w));
    if (bad.length) return errors.push(`${where}: unknown context ${bad.map((b) => `"${b}"`).join(", ")}`);
    const when = u.when?.length ? (u.when as FocusContext[]) : undefined;
    // replace in the user's contexts: drop defaults for this key there
    bindings = bindings.flatMap((b) => {
      if (b.key !== key) return [b];
      if (!when) return []; // global user entry replaces the key everywhere
      if (!b.when?.length) return [b]; // keep the global default outside the user's contexts
      const rest = b.when.filter((w) => !when.includes(w));
      return rest.length ? [{ ...b, when: rest }] : [];
    });
    if (u.command !== "none") added.push({ key, command: u.command as CommandId, when });
  });
  const merged = [...added, ...bindings];
  errors.push(...collisions(added).map((c) => `keybindings.yaml: ${c}`));
  return { bindings: merged, errors };
}

/** Canonicalizes a user-written chord ("cmd+shift+d", "Meta+Shift+D"). */
export function canonicalKey(k: string): string | undefined {
  const parts = k.split("+").map((p) => p.trim());
  if (parts.some((p) => !p) && k !== "+") return undefined;
  const key = parts.pop()!;
  const alias: Record<string, (typeof modOrder)[number]> = {
    cmd: "Meta", meta: "Meta", command: "Meta", "⌘": "Meta",
    ctrl: "Ctrl", control: "Ctrl", "⌃": "Ctrl",
    alt: "Alt", opt: "Alt", option: "Alt", "⌥": "Alt",
    shift: "Shift", "⇧": "Shift",
  };
  const mods = new Set<string>();
  for (const p of parts) {
    const m = alias[p.toLowerCase()];
    if (!m) return undefined;
    mods.add(m);
  }
  const named: Record<string, string> = { esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: "Space", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", pageup: "PageUp", pagedown: "PageDown" };
  const k2 = key.length === 1 ? key.toUpperCase() : (named[key.toLowerCase()] ?? key);
  return [...modOrder.filter((m) => mods.has(m)), k2].join("+");
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
