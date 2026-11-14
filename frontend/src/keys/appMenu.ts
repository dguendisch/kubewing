/**
 * The native macOS menu bar, described from the live keymap. Pure: Go only
 * renders what this returns (internal/app/menu.go), and a click comes back as
 * a kw:command event into the single dispatcher.
 *
 * Every item shows its key where macOS shows key equivalents, but only a
 * global ⌘ chord is a working one. The page sees every key before the menu
 * does, and a key the keymap resolves is consumed there, so such an item never
 * fires twice; it only takes over when the page can't (busy, nothing focused).
 * A scoped chord would fire window-wide, also where the keymap leaves the key
 * to a text field (⌘← in the filter bar), and a plain letter would hijack
 * typing: those are displayOnly, and Go keeps AppKit from firing them
 * (internal/app/menukeys_darwin.go).
 */
import { defaultBindings, type Binding, type CommandId } from "./keymap";

export interface MenuItem {
  label: string;
  /** Unset on a submenu. */
  command?: CommandId;
  /** Native key equivalent in Wails syntax ("CmdOrCtrl+Shift+d"). */
  accelerator?: string;
  /** The accelerator is only shown: the page handles the key, natively it never fires. */
  displayOnly?: true;
  /** A submenu's items (null = separator). */
  items?: (MenuItem | null)[];
}

export interface Menu {
  title: string;
  /** null = separator. */
  items: (MenuItem | null)[];
}

type Entry = [label: string, command: CommandId] | { submenu: string; entries: Entry[] } | null;

const tabJumps = ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n): Entry => [n === 9 ? "Last Tab" : `Tab ${n}`, `tab.goto${n}`]);

/** The app menu's title: Go merges this menu's items into it (after "Check for Updates…") instead of adding a menu. */
export const APP_MENU = "kubewing";

/** Menu layout; every app-level command a user would look for in a menu bar. */
const layout: { title: string; entries: Entry[] }[] = [
  // where macOS apps have their settings (⌘,): config.yaml and keybindings.yaml
  { title: APP_MENU, entries: [{ submenu: "Settings", entries: [["General…", "config.edit"], ["Keyboard Shortcuts…", "config.editKeys"]] }] },
  {
    title: "File",
    entries: [["New Tab", "tab.new"], ["Open…", "source.open"], ["Open Cluster…", "cluster.open"], ["Shoot ⇄ Control Plane", "cluster.otherPlane"], null, ["Close Tab", "tab.close"], ["Close Pane", "pane.close"], null, ["Refresh Listing", "source.refresh"], ["Reconnect", "source.reconnect"], ["Reload Config", "config.reload"]],
  },
  {
    title: "Object",
    entries: [
      ["View YAML", "detail.open"],
      ["Diff Last Change", "object.diff"],
      ["Describe", "object.describe"],
      ["Copy", "table.copy"],
      ["Copy Name", "object.copyName"],
      ["Copy Cell(s)…", "object.copyCell"],
      null,
      ["Logs…", "object.logs"],
      ["Logs of Pane…", "view.logs"],
      ["Exec Shell", "object.exec"],
      ["Debug Container…", "object.debug"],
      ["Node Shell…", "object.opsPod"],
      ["Port-Forward…", "object.portForward"],
      ["Port-Forwards", "portforward.list"],
      null,
      ["Label…", "object.label"],
      ["Annotate…", "object.annotate"],
      ["Scale…", "object.scale"],
      null,
      ["Delete…", "object.delete"],
      null,
      ["Jump To…", "object.jump"],
      ["Events", "object.events"],
      ["All Actions…", "object.menu"],
    ],
  },
  {
    title: "View",
    entries: [
      ["Filter Rows", "filter.focus"],
      ["Filter by Labels", "filter.focusLabels"],
      ["Filter by CEL", "filter.focusCel"],
      ["Hide Healthy", "filter.toggleHealthy"],
      ["Columns…", "view.columns"],
      ["Metrics", "view.toggleMetrics"],
      ["Requests / Limits", "view.toggleAllocation"],
      null,
      ["Toggle Line Wrap", "detail.toggleWrap"],
      ["Toggle Blame", "detail.toggleBlame"],
      null,
      ["Zoom In", "view.zoomIn"],
      ["Zoom Out", "view.zoomOut"],
      ["Actual Size", "view.zoomReset"],
      null,
      ["Find in Terminal", "term.find"],
      ["Find Next", "term.findNext"],
      ["Find Previous", "term.findPrev"],
    ],
  },
  {
    title: "Pane",
    entries: [
      ["Split Down", "pane.splitDown"],
      ["Split Right", "pane.splitRight"],
      ["Terminal Below", "terminal.splitDown"],
      ["Terminal Right", "terminal.splitRight"],
      ["Maximize Pane", "pane.toggleMaximize"],
      ["Name Pane…", "pane.rename"],
      null,
      ["Next Pane", "pane.focusNext"],
      ["Previous Pane", "pane.focusPrev"],
      ["Pane Left", "pane.focusLeft"],
      ["Pane Right", "pane.focusRight"],
      ["Pane Above", "pane.focusUp"],
      ["Pane Below", "pane.focusDown"],
      null,
      ["Move Divider Left", "pane.resizeLeft"],
      ["Move Divider Right", "pane.resizeRight"],
      ["Move Divider Up", "pane.resizeUp"],
      ["Move Divider Down", "pane.resizeDown"],
      null,
      ["Back", "history.back"],
      ["Forward", "history.forward"],
    ],
  },
  {
    title: "Tab",
    entries: [["Name Tab…", "tab.rename"], null, ["Next Tab", "tab.next"], ["Previous Tab", "tab.prev"], null, ...tabJumps],
  },
  {
    title: "Help",
    entries: [
      ["Keyboard Shortcuts", "help.toggle"],
      null,
      ["Find in Shortcuts", "help.find"],
      ["Find Next", "help.findNext"],
      ["Find Previous", "help.findPrev"],
    ],
  },
];

/** The menu bar for a keymap. Pure. */
export function menuSpec(bindings: Binding[] = defaultBindings): Menu[] {
  const items = (entries: Entry[]): (MenuItem | null)[] =>
    entries.map((e) => (!e ? null : Array.isArray(e) ? item(e[0], e[1], bindings) : { label: e.submenu, items: items(e.entries) }));
  return layout.map((m) => ({ title: m.title, items: items(m.entries) }));
}

function item(label: string, command: CommandId, bindings: Binding[]): MenuItem {
  const own = bindings.filter((b) => b.command === command);
  // the first global ⌘ chord whose key is not taken by another command in some context
  const native = own.find((b) => !b.when?.length && b.key.split("+").includes("Meta") && !shadowed(b, bindings));
  if (native) return { label, command, accelerator: accelerator(native.key) };
  // otherwise only show the key, as the cheat sheet would
  return own.length ? { label, command, accelerator: accelerator(own[0]!.key), displayOnly: true } : { label, command };
}

/** A global chord that some context binds to another command: natively it would fire there too. */
const shadowed = (b: Binding, bindings: Binding[]) => bindings.some((o) => o.key === b.key && o.command !== b.command && o.when?.length);

const accelMods: Record<string, string> = { Meta: "CmdOrCtrl", Ctrl: "Ctrl", Alt: "OptionOrAlt", Shift: "Shift" };
const accelKeys: Record<string, string> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  Enter: "return", Escape: "escape", Tab: "tab", Space: "space", Backspace: "backspace", Delete: "forward delete",
  PageUp: "page up", PageDown: "page down", "+": "plus",
};

/** A keymap chord ("Meta+Shift+D") as a Wails accelerator ("CmdOrCtrl+Shift+d"). */
export function accelerator(key: string): string {
  const parts = key.split("+");
  // "Meta++" would split into an empty key: the key is the last part, "+" if that's empty
  let k = parts.pop()!;
  if (k === "" && key.endsWith("+")) {
    parts.pop();
    k = "+";
  }
  const name = accelKeys[k] ?? k.toLowerCase();
  return [...parts.map((m) => accelMods[m] ?? m), name].join("+");
}
