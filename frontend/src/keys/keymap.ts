/**
 * Keymap resolution: (key chord, focus context) → command id. Pure.
 *
 * Every key path (JS keydown, native menu accelerator) resolves through
 * resolve() into the single command dispatcher (src/commands.ts).
 */
export const focusContexts = ["table", "filter", "detail", "palette", "dialog", "switcher", "confirm", "terminal", "ended", "termfind", "logs", "logsfilter", "logsfind", "forwards", "menu", "help", "edit", "editpreview", "travel"] as const;
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
  | "pane.toggleMaximize"
  | "pane.rename"
  | "tab.new"
  | "tab.rename"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | `tab.goto${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | "tab.mruNext"
  | "tab.mruPrev"
  | "tab.switcherCommit"
  | "tab.switcherCancel"
  | "filter.focus"
  | "filter.focusLabels"
  | "filter.focusCel"
  | "filter.toggleHealthy"
  | "filter.blur"
  | "filter.fromDetail"
  | "filter.fromDetailNot"
  | "row.down"
  | "row.up"
  | "row.pageDown"
  | "row.pageUp"
  | "row.first"
  | "row.last"
  | "detail.open"
  | "detail.openSplit"
  | "detail.close"
  | "detail.toggleDiff"
  | "detail.showYaml"
  | "detail.refresh"
  | "detail.toggleWrap"
  | "detail.decode"
  | "diff.next"
  | "diff.prev"
  | "diff.older"
  | "diff.newer"
  | "source.open"
  | "cluster.open"
  | "cluster.otherPlane"
  | "config.reload"
  | "source.reconnect"
  | "source.refresh"
  | "object.delete"
  | "object.diff"
  | "object.copyName"
  | "table.copy"
  | "table.clearSelection"
  | "object.copyCell"
  | "object.menu"
  | "object.jump"
  | "object.events"
  | "menu.run"
  | "menu.runSplit"
  | "menu.runTab"
  | "history.back"
  | "history.forward"
  | "object.describe"
  | "object.describeSplit"
  | "object.exec"
  | "object.edit"
  | "object.editSplit"
  | "object.debug"
  | "object.opsPod"
  | "terminal.splitDown"
  | "terminal.splitRight"
  | "object.portForward"
  | "object.label"
  | "object.annotate"
  | "object.scale"
  | "object.logs"
  | "view.logs"
  | "logs.focusFilter"
  | "logs.blurFilter"
  | "logs.toggleTimestamps"
  | "logs.clear"
  | "logs.find"
  | "logs.findNext"
  | "logs.findPrev"
  | "logs.findClose"
  | "logs.lineDown"
  | "logs.lineUp"
  | "logs.pageDown"
  | "logs.pageUp"
  | "logs.top"
  | "logs.bottom"
  | "portforward.list"
  | "portforward.stop"
  | "confirm.accept"
  | "confirm.cancel"
  | "help.toggle"
  | "edit.submit"
  | "edit.back"
  | "term.find"
  | "term.findNext"
  | "term.findPrev"
  | "term.findClose"
  | "view.columns"
  | "view.toggleMetrics"
  | "view.toggleAllocation"
  | "history.toggleRecording"
  | "travel.toggle"
  | "travel.prev"
  | "travel.next"
  | "travel.back"
  | "travel.forward"
  | "travel.start"
  | "travel.live"
  | "travel.field";

/** Every command id, for validating user keybindings. */
export const commandIds: readonly CommandId[] = [
  "pane.splitRight", "pane.splitDown", "pane.close", "pane.focusNext", "pane.focusPrev",
  "pane.focusLeft", "pane.focusRight", "pane.focusUp", "pane.focusDown", "pane.toggleMaximize", "pane.rename",
  "tab.new", "tab.rename", "tab.close", "tab.next", "tab.prev",
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => `tab.goto${n}` as const),
  "tab.mruNext", "tab.mruPrev", "tab.switcherCommit", "tab.switcherCancel",
  "filter.focus", "filter.focusLabels", "filter.focusCel", "filter.toggleHealthy", "filter.blur", "filter.fromDetail", "filter.fromDetailNot",
  "row.down", "row.up", "row.pageDown", "row.pageUp", "row.first", "row.last",
  "detail.open", "detail.openSplit", "detail.close", "detail.toggleDiff", "detail.showYaml", "detail.refresh", "detail.toggleWrap", "detail.decode", "diff.next", "diff.prev", "diff.older", "diff.newer",
  "source.open", "cluster.open", "cluster.otherPlane", "config.reload", "source.reconnect", "source.refresh",
  "object.delete", "object.diff", "object.copyName", "table.copy", "table.clearSelection", "object.copyCell", "object.menu", "object.jump", "object.events", "menu.run", "menu.runSplit", "menu.runTab", "history.back", "history.forward", "object.describe", "object.describeSplit", "object.exec", "object.edit", "object.editSplit", "object.debug", "object.opsPod", "terminal.splitDown", "terminal.splitRight", "object.portForward", "object.label", "object.annotate", "object.scale", "object.logs", "view.logs",
  "logs.focusFilter", "logs.blurFilter", "logs.toggleTimestamps", "logs.clear", "logs.find", "logs.findNext", "logs.findPrev", "logs.findClose",
  "logs.lineDown", "logs.lineUp", "logs.pageDown", "logs.pageUp", "logs.top", "logs.bottom",
  "portforward.list", "portforward.stop", "confirm.accept", "confirm.cancel", "help.toggle", "edit.submit", "edit.back",
  "term.find", "term.findNext", "term.findPrev", "term.findClose",
  "view.columns", "view.toggleMetrics", "view.toggleAllocation", "history.toggleRecording",
  "travel.toggle", "travel.prev", "travel.next", "travel.back", "travel.forward", "travel.start", "travel.live", "travel.field",
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
  // not global: ⌃D is forward-delete in text fields, and the shell's EOF in a terminal
  // (once the shell has ended, "ended", there is no shell left to want it)
  { key: "Ctrl+D", command: "pane.close", when: ["table", "detail", "menu", "help", "ended", "logs"] },
  // the same in every pane kind, and the escape hatch from a shell that ignores ⌃D
  { key: "Ctrl+Shift+D", command: "pane.close", when: ["table", "detail", "menu", "help", "ended", "terminal", "logs"] },
  { key: "Meta+]", command: "pane.focusNext" },
  { key: "Meta+[", command: "pane.focusPrev" },
  { key: "Alt+Meta+ArrowLeft", command: "pane.focusLeft" },
  { key: "Alt+Meta+ArrowRight", command: "pane.focusRight" },
  { key: "Alt+Meta+ArrowUp", command: "pane.focusUp" },
  { key: "Alt+Meta+ArrowDown", command: "pane.focusDown" },
  // iTerm's "maximize active pane"; global, so it works from a shell and the YAML editor too
  { key: "Meta+Shift+Enter", command: "pane.toggleMaximize" },
  // iTerm's "Edit Tab Title" (⌘⇧I) and "Edit Session" (⌘I) name tabs and panes; a double-click does too.
  // Global, so a shell's pane can be named as well
  { key: "Meta+I", command: "pane.rename" },
  { key: "Meta+Shift+I", command: "tab.rename" },
  { key: "Meta+T", command: "tab.new" },
  // more than one pane in the tab: the dispatcher asks first
  { key: "Meta+W", command: "tab.close" },
  // the macOS tab keys (Safari, Terminal, iTerm); ⌘←/⌘→ are the jump history
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
  // ⌘P: the webview's print otherwise (suppressed); a cluster from recent ones, gardenctl, a dashboard URL
  { key: "Meta+P", command: "cluster.open" },
  // the focused pane from a shoot to its control plane (the seed, in the shoot's namespace) and back;
  // in ⌘O too (only there of the dialogs): a cluster just opened has it open over it
  { key: "Meta+Shift+P", command: "cluster.otherPlane", when: ["table", "detail", "dialog"] },
  { key: "Meta+Shift+,", command: "config.reload" },
  // the focused pane's context: a fresh connection and fresh lists (after the network was down, a stuck watch);
  // global, as the browser's hard reload (and ⌘R is the webview's, suppressed)
  { key: "Meta+Shift+R", command: "source.reconnect" },
  // a listing (everything in a namespace) lists again: it isn't watched; what changed since is marked
  { key: "Meta+R", command: "source.refresh", when: ["table", "detail"] },
  { key: "/", command: "filter.focus", when: ["table"] },
  { key: "L", command: "filter.focusLabels", when: ["table"] },
  { key: "C", command: "filter.focusCel", when: ["table"] },
  { key: "H", command: "filter.toggleHealthy", when: ["table"] },
  // as in kubectl get -o wide
  { key: "O", command: "view.columns", when: ["table"] },
  // kubectl top: CPU/memory columns of pods and nodes (for the type, like -o wide)
  { key: "M", command: "view.toggleMetrics", when: ["table"] },
  // kubectl describe node's allocated resources: requests/limits of each node's pods (lists all pods first)
  { key: "Shift+M", command: "view.toggleAllocation", when: ["table"] },
  // record changes for the source (off by default: it costs per event)
  { key: "Shift+R", command: "history.toggleRecording", when: ["table"] },
  // time-travel: t in the table; while in the past ("travel": the table keys still apply) the arrows move in time
  { key: "T", command: "travel.toggle", when: ["table", "travel"] },
  { key: "ArrowLeft", command: "travel.prev", when: ["travel"] },
  { key: "ArrowRight", command: "travel.next", when: ["travel"] },
  { key: "Shift+ArrowLeft", command: "travel.back", when: ["travel"] },
  { key: "Shift+ArrowRight", command: "travel.forward", when: ["travel"] },
  { key: "Home", command: "travel.start", when: ["travel"] },
  { key: "End", command: "travel.live", when: ["travel"] },
  { key: "Escape", command: "travel.live", when: ["travel"] },
  // in the YAML: the history of the field under the cursor
  { key: "Shift+H", command: "travel.field", when: ["detail"] },
  // in the detail view ⌘F is Monaco's find
  { key: "Meta+F", command: "filter.focus", when: ["table", "filter"] },
  { key: "Escape", command: "filter.blur", when: ["filter"] },
  // in an object view: a decoded level up; at the top, back to the table (or a split closes)
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
  // the row's YAML in place of the table (Esc or ⌘← back to it); ⇧⏎ in a split to the right, to compare
  { key: "Enter", command: "detail.open", when: ["table"] },
  { key: "Y", command: "detail.open", when: ["table"] },
  { key: "Shift+Enter", command: "detail.openSplit", when: ["table", "detail"] },
  { key: "D", command: "detail.toggleDiff", when: ["detail"] },
  { key: "Y", command: "detail.showYaml", when: ["detail"] },
  { key: "R", command: "detail.refresh", when: ["detail"] },
  { key: "W", command: "detail.toggleWrap", when: ["detail"] },
  // next/previous change in a diff (vim-like, as in the table); no-ops elsewhere
  { key: "J", command: "diff.next", when: ["detail", "editpreview"] },
  { key: "K", command: "diff.prev", when: ["detail", "editpreview"] },
  // older/newer version of the object in its diff (the shared watch's history)
  { key: "[", command: "diff.older", when: ["detail"] },
  { key: "]", command: "diff.newer", when: ["detail"] },
  // the value under the cursor decoded (base64, brotli, JWT, certificates …); again inside it: deeper
  { key: "Enter", command: "detail.decode", when: ["detail"] },
  // the YAML line under the cursor becomes the pane's CEL filter
  { key: "=", command: "filter.fromDetail", when: ["detail"] },
  { key: "!", command: "filter.fromDetailNot", when: ["detail"] },
  // k9s binds ⌃D, but that's the pane/shell key here; ⌘⌫ is the macOS "move to trash" idiom
  { key: "Meta+Backspace", command: "object.delete", when: ["table"] },
  { key: "Delete", command: "object.delete", when: ["table"] },
  // context menu of the selected row (also right-click): every row action, generated from actions/registry.ts
  { key: "Meta+Enter", command: "object.menu", when: ["table"] },
  // table only: in fields, Monaco and terminals ⌘C stays the native copy. The text selected
  // in a cell (double-click a word, triple-click the cell, drag), else the row's name
  { key: "Meta+C", command: "table.copy", when: ["table"] },
  { key: "Escape", command: "table.clearSelection", when: ["table"] },
  // any other cell: a picker of the row's columns (right-click a cell: that one is highlighted)
  { key: "Meta+Shift+C", command: "object.copyCell", when: ["table"] },
  { key: "Escape", command: "detail.close", when: ["menu"] },
  { key: "J", command: "row.down", when: ["menu"] },
  { key: "ArrowDown", command: "row.down", when: ["menu"] },
  { key: "K", command: "row.up", when: ["menu"] },
  { key: "ArrowUp", command: "row.up", when: ["menu"] },
  { key: "Enter", command: "menu.run", when: ["menu"] },
  // jump menu: ⇧⏎ opens the target in a split below instead of in place
  { key: "Shift+Enter", command: "menu.runSplit", when: ["menu"] },
  // jump menu: ⌘⏎ opens a cluster (a shoot's, control plane's, seed's) in a new tab
  { key: "Meta+Enter", command: "menu.runTab", when: ["menu"] },
  // ⌘J: where this row leads (namespace, owners, owned); jumps in place are a browser-like history:
  // ⌘← back, ⌘→ forward again (table only: in text fields they're start/end of line)
  // in an object's YAML (the editor too): the references at the cursor first
  { key: "Meta+J", command: "object.jump", when: ["table", "detail", "edit"] },
  { key: "Meta+ArrowLeft", command: "history.back", when: ["table", "detail"] },
  { key: "Meta+ArrowRight", command: "history.forward", when: ["table", "detail"] },
  // the row's events: a jump to the events about it (⌘← back to the row)
  { key: "V", command: "object.events", when: ["table", "detail"] },
  { key: "D", command: "object.describe", when: ["table"] },
  // describe in a split to the right, like ⇧⏎ / ⇧E; in the detail view d is the diff toggle, so ⇧D is describe there
  { key: "Shift+D", command: "object.describeSplit", when: ["table"] },
  { key: "Shift+D", command: "object.describe", when: ["detail"] },
  // e edits (as kubectl edit, also from the YAML view); exec is x (k9s' "s" is the shell there, x for eXec)
  { key: "E", command: "object.edit", when: ["table", "detail"] },
  // the editor in a split to the right: the table (or the object) stays as it is
  { key: "Shift+E", command: "object.editSplit", when: ["table", "detail"] },
  { key: "X", command: "object.exec", when: ["table"] },
  // the editor: ⌘S / ⌘⏎ dry-run into the diff preview; there ⏎ (or ⌘S / ⌘⏎ again) writes, esc goes back to the editor
  { key: "Meta+S", command: "edit.submit", when: ["edit", "editpreview"] },
  { key: "Meta+Enter", command: "edit.submit", when: ["edit", "editpreview"] },
  { key: "Enter", command: "edit.submit", when: ["editpreview"] },
  { key: "Escape", command: "edit.back", when: ["edit", "editpreview"] },
  { key: "W", command: "detail.toggleWrap", when: ["editpreview"] },
  { key: "B", command: "object.debug", when: ["table"] },
  // from anywhere (also a terminal pane): the node is prefilled from the selected row, if any
  { key: "Alt+Meta+O", command: "object.opsPod" },
  // a local shell with the focused pane's kubeconfig context and namespace, in a split below / to the right.
  // Not in a running shell (⌃T is its own there: transpose, fzf's file picker), nor in text fields
  { key: "Ctrl+T", command: "terminal.splitDown", when: ["table", "detail", "ended", "logs"] },
  { key: "Ctrl+Shift+T", command: "terminal.splitRight", when: ["table", "detail", "ended", "logs"] },
  { key: "F", command: "object.portForward", when: ["table"] },
  // kubectl label / annotate / scale (l is the label filter, a free)
  { key: "Shift+L", command: "object.label", when: ["table"] },
  { key: "Shift+A", command: "object.annotate", when: ["table"] },
  { key: "S", command: "object.scale", when: ["table"] },
  // logs (stern-like): ⌘L tails the selected row's pods, ⌥⌘L every pod the pods pane shows
  { key: "Meta+L", command: "object.logs", when: ["table"] },
  { key: "Alt+Meta+L", command: "view.logs", when: ["table"] },
  // in a log pane: / focuses the filter, t toggles timestamps, ⌘K clears, ⌘F finds
  { key: "/", command: "logs.focusFilter", when: ["logs"] },
  { key: "Escape", command: "logs.blurFilter", when: ["logsfilter"] },
  { key: "Enter", command: "logs.blurFilter", when: ["logsfilter"] },
  { key: "T", command: "logs.toggleTimestamps", when: ["logs"] },
  { key: "Meta+K", command: "logs.clear", when: ["logs"] },
  { key: "Meta+F", command: "logs.find", when: ["logs", "logsfilter", "logsfind"] },
  { key: "Meta+G", command: "logs.findNext", when: ["logs", "logsfilter", "logsfind"] },
  { key: "Meta+Shift+G", command: "logs.findPrev", when: ["logs", "logsfilter", "logsfind"] },
  { key: "Enter", command: "logs.findNext", when: ["logsfind"] },
  { key: "Shift+Enter", command: "logs.findPrev", when: ["logsfind"] },
  { key: "Escape", command: "logs.findClose", when: ["logsfind"] },
  // scrolling the log view: the usual keys; ⏎ jumps back to the latest line (and keeps following)
  { key: "ArrowDown", command: "logs.lineDown", when: ["logs"] },
  { key: "ArrowUp", command: "logs.lineUp", when: ["logs"] },
  { key: "PageDown", command: "logs.pageDown", when: ["logs"] },
  { key: "PageUp", command: "logs.pageUp", when: ["logs"] },
  { key: "Home", command: "logs.top", when: ["logs"] },
  { key: "Alt+ArrowUp", command: "logs.top", when: ["logs"] },
  { key: "End", command: "logs.bottom", when: ["logs"] },
  { key: "Alt+ArrowDown", command: "logs.bottom", when: ["logs"] },
  { key: "Enter", command: "logs.bottom", when: ["logs"] },
  { key: "Alt+Meta+P", command: "portforward.list" },
  // the same keys as the running forwards in the f dialog: ↑/↓ pick, x or ⌫ stops
  { key: "X", command: "portforward.stop", when: ["forwards"] },
  { key: "Backspace", command: "portforward.stop", when: ["forwards"] },
  { key: "Escape", command: "detail.close", when: ["forwards"] },
  { key: "ArrowDown", command: "row.down", when: ["forwards"] },
  { key: "ArrowUp", command: "row.up", when: ["forwards"] },
  { key: "Escape", command: "confirm.cancel", when: ["confirm"] },
  // not global: in the filter bar and the dialogs "?" is text being typed
  { key: "?", command: "help.toggle", when: ["table", "detail", "ended", "forwards", "menu", "help"] },
  { key: "Escape", command: "detail.close", when: ["help"] },
  // find in a terminal (as Monaco's): ⌘F opens the bar, ⌘G / ⌘⇧G step, Esc closes back to the shell
  { key: "Meta+F", command: "term.find", when: ["terminal", "ended", "termfind"] },
  { key: "Meta+G", command: "term.findNext", when: ["terminal", "ended", "termfind"] },
  { key: "Meta+Shift+G", command: "term.findPrev", when: ["terminal", "ended", "termfind"] },
  { key: "Enter", command: "term.findNext", when: ["termfind"] },
  { key: "Shift+Enter", command: "term.findPrev", when: ["termfind"] },
  { key: "Escape", command: "term.findClose", when: ["termfind"] },
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
 * on any layout. "?" and "!" need ⇧ on every common layout, so ⇧ is dropped
 * for them.
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
  const parts = modOrder.filter((m) => mods[m] && !(m === "Shift" && (key === "?" || key === "!")));
  return [...parts, key].join("+");
}

/**
 * In a terminal every key belongs to the shell (⌃C, ⌃D, Esc, arrows …);
 * only ⌘ chords, ⌃⇥ MRU switching and ⌃⇧D (close a stuck shell's pane;
 * terminals send it as plain ⌃D anyway) reach the app.
 */
export function terminalReserved(key: string): boolean {
  const mods = key.split("+").slice(0, -1);
  return !mods.includes("Meta") && !/^Ctrl(\+Shift)?\+Tab$/.test(key) && key !== "Ctrl+Shift+D";
}

/**
 * In Monaco's find field the keys are text being typed (d, j, =, ⌃D …);
 * only ⌘ chords and ⌃⇥ MRU switching reach the app, except ⌘←/⌘→, which
 * jump to the start/end of the field.
 */
export function fieldReserved(key: string): boolean {
  const mods = key.split("+").slice(0, -1);
  if (/^Ctrl(\+Shift)?\+Tab$/.test(key)) return false;
  return !mods.includes("Meta") || key === "Meta+ArrowLeft" || key === "Meta+ArrowRight";
}

/** Resolves a chord in a focus context; context-specific bindings win over global ones. */
/**
 * The contexts a key resolves in, most specific first: a table showing the
 * past ("travel") has the travel keys, then the table's.
 */
export function keyContexts(focus: FocusContext, traveling: boolean): FocusContext[] {
  return focus === "table" && traveling ? ["travel", "table"] : [focus];
}

/** resolve over keyContexts: the first context with a binding for the key wins. */
export function resolveIn(key: string, contexts: FocusContext[], bindings: Binding[] = defaultBindings): CommandId | undefined {
  for (const c of contexts) {
    const cmd = resolveOwn(key, c, bindings);
    if (cmd) return cmd;
  }
  return resolve(key, contexts[contexts.length - 1]!, bindings);
}

/** A binding for key in exactly this context (no global fallback). */
function resolveOwn(key: string, focus: FocusContext, bindings: Binding[]): CommandId | undefined {
  for (const b of bindings) if (b.key === key && b.when?.includes(focus)) return b.command;
  return undefined;
}

/**
 * The YAML editor and its preview are modal: only their own keys (Esc, ⌘S,
 * ⌘⏎ …) reach the app, every other key is Monaco's (⌘D deletes a line
 * there); a stray ⌘W mustn't take an edit along. Moving the focus elsewhere
 * is fine: the editor stays in its pane, as typed, and the focus can come
 * back to it (its pane is marked as holding changes meanwhile).
 */
export const editorModal = (focus: FocusContext) => focus === "edit" || focus === "editpreview";

/**
 * Global commands that only move the focus (or maximize its pane): they reach
 * the app from the editor too. Not ⌘[ / ⌘] (next/previous pane): they're the
 * editor's indent.
 */
const focusMoves = new Set<CommandId>([
  "pane.toggleMaximize",
  "pane.focusLeft", "pane.focusRight", "pane.focusUp", "pane.focusDown",
  "tab.next", "tab.prev", "tab.mruNext", "tab.mruPrev",
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => `tab.goto${n}` as const),
]);
export const editorMoves = (c: CommandId) => focusMoves.has(c);

export function resolve(key: string, focus: FocusContext, bindings: Binding[] = defaultBindings): CommandId | undefined {
  if (focus === "terminal" && terminalReserved(key)) return undefined;
  // the editor is a text field: keys are text (Esc leaves it)
  if (focus === "edit" && key !== "Escape" && fieldReserved(key)) return undefined;
  let global: CommandId | undefined;
  for (const b of bindings) {
    if (b.key !== key) continue;
    if (b.when?.includes(focus)) return b.command;
    if (!b.when?.length && global === undefined) global = b.command;
  }
  return editorModal(focus) && !(global && focusMoves.has(global)) ? undefined : global;
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
  const named: Record<string, string> = { esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: "Space", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", pageup: "PageUp", pagedown: "PageDown", backspace: "Backspace", delete: "Delete", del: "Delete" };
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

const symbols: Record<string, string> = {
  Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧",
  Enter: "⏎", Escape: "esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "␣", Tab: "⇥", Backspace: "⌫", Delete: "⌦",
};

/** "Shift+D" → "⇧D", "Ctrl+D" → "⌃D", "S" → "s". */
export function prettyKey(key: string): string {
  const parts = key.split("+");
  const k = parts.pop()!;
  const mods = parts.map((m) => symbols[m] ?? m).join("");
  const name = symbols[k] ?? (k.length === 1 && !mods ? k.toLowerCase() : k);
  return mods + name;
}
