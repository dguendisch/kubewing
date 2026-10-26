/**
 * The cheat sheet (?): every command of the live keymap with its keys, in
 * reading order. Pure, so the layout is a unit test rather than a screenshot.
 *
 * Sections list commands, not keys: the chords come from the merged bindings,
 * so a user's keybindings.yaml shows up here as it is. A unit test fails for
 * any command id that no section mentions.
 */
import { defaultBindings, prettyKey, type Binding, type CommandId, type FocusContext } from "./keymap";

/** One line of the sheet; several commands share a line when they're a pair (next/previous). */
interface Row {
  label: string;
  commands: CommandId[];
  /** Show the keys as a range ("⌘1–⌘9") instead of listing all of them. */
  range?: boolean;
  /** Only the keys bound in this context; lets a section repeat a command that works there too. */
  in?: FocusContext;
}

export interface Entry {
  label: string;
  /** Pretty chords, deduplicated and in keymap order. */
  keys: string[];
  /** Where the keys work; empty = everywhere. */
  when: FocusContext[];
}

export interface Section {
  title: string;
  entries: Entry[];
}

const row = (label: string, ...commands: CommandId[]): Row => ({ label, commands });

/** A row for a command listed elsewhere, showing its keys in one context only. */
const rowIn = (context: FocusContext, label: string, ...commands: CommandId[]): Row => ({ label, commands, in: context });

const tabJumps = ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n): CommandId => `tab.goto${n}`);

const sections: { title: string; rows: Row[] }[] = [
  {
    title: "panes",
    rows: [
      row("split down", "pane.splitDown"),
      row("split right", "pane.splitRight"),
      row("close pane", "pane.close"),
      row("maximize pane / show all again", "pane.toggleMaximize"),
      row("next / previous pane", "pane.focusNext", "pane.focusPrev"),
      row("pane left / right", "pane.focusLeft", "pane.focusRight"),
      row("pane above / below", "pane.focusUp", "pane.focusDown"),
    ],
  },
  {
    title: "tabs",
    rows: [
      row("new tab", "tab.new"),
      row("close tab", "tab.close"),
      row("next / previous tab", "tab.next", "tab.prev"),
      { label: "go to tab 1–9 (9 = last)", commands: tabJumps, range: true },
      row("switch tabs in MRU order", "tab.mruNext", "tab.mruPrev"),
      row("take the highlighted tab", "tab.switcherCommit"),
      row("cancel the switch", "tab.switcherCancel"),
    ],
  },
  {
    title: "table",
    rows: [
      row("filter rows", "filter.focus"),
      row("filter by label selector", "filter.focusLabels"),
      row("filter by CEL expression", "filter.focusCel"),
      row("hide / show healthy pods and workloads", "filter.toggleHealthy"),
      row("columns: -o wide, custom ones (also right-click the header)", "view.columns"),
      row("leave the filter bar", "filter.blur"),
      row("next / previous row", "row.down", "row.up"),
      row("page down / up", "row.pageDown", "row.pageUp"),
      row("first / last row", "row.first", "row.last"),
    ],
  },
  {
    title: "object",
    rows: [
      row("view YAML", "detail.open"),
      row("diff last change", "object.diff"),
      row("copy name", "object.copyName"),
      row("describe", "object.describe"),
      row("edit YAML…", "object.edit"),
      row("exec shell", "object.exec"),
      row("debug container…", "object.debug"),
      row("node shell… (the row's node, or any)", "object.opsPod"),
      row("port-forward…", "object.portForward"),
      row("delete…", "object.delete"),
      row("all actions for the row", "object.menu"),
      row("run the highlighted action", "menu.run"),
      row("jump to namespace / owner / owned", "object.jump"),
      row("events of the row (⌘← back)", "object.events"),
      row("jump into a split below", "menu.runSplit"),
      row("back / forward (jumps, ⌘O)", "history.back", "history.forward"),
    ],
  },
  {
    title: "detail view",
    rows: [
      row("back to YAML", "detail.showYaml"),
      row("toggle diff", "detail.toggleDiff"),
      row("re-run describe", "detail.refresh"),
      rowIn("detail", "edit YAML…", "object.edit"),
      rowIn("detail", "jump to namespace / owner / owned", "object.jump"),
      rowIn("detail", "events of the object", "object.events"),
      row("wrap long lines on / off", "detail.toggleWrap"),
      row("next / previous change (diff)", "diff.next", "diff.prev"),
      row("filter: field under cursor == / != its value", "filter.fromDetail", "filter.fromDetailNot"),
      row("close", "detail.close"),
    ],
  },
  {
    title: "edit",
    rows: [
      row("preview the change (server dry run), then apply", "edit.submit"),
      row("back to editing / close", "edit.back"),
    ],
  },
  {
    title: "terminal",
    rows: [
      row("find", "term.find"),
      row("next / previous match", "term.findNext", "term.findPrev"),
      row("close find", "term.findClose"),
    ],
  },
  {
    title: "port-forwards",
    rows: [
      row("list port-forwards", "portforward.list"),
      row("stop the highlighted one", "portforward.stop"),
    ],
  },
  {
    title: "app",
    rows: [
      row("open context / resource / ns", "source.open"),
      row("reload the config", "config.reload"),
      row("this cheat sheet", "help.toggle"),
      row("run the prepared action", "confirm.accept"),
      row("cancel the prepared action", "confirm.cancel"),
    ],
  },
];

/** Every command the sheet shows; used by the completeness test. */
export const listedCommands: readonly CommandId[] = sections.flatMap((s) => s.rows.flatMap((r) => r.commands));

/** The commands of the unscoped rows, which must each appear once. */
export const primaryCommands: readonly CommandId[] = sections.flatMap((s) => s.rows.filter((r) => !r.in).flatMap((r) => r.commands));

/** The sheet for a keymap. Unbound commands and empty sections are left out. Pure. */
export function cheatsheet(bindings: Binding[] = defaultBindings): Section[] {
  return sections
    .map((s) => ({ title: s.title, entries: s.rows.map((r) => entry(r, bindings)).filter((e): e is Entry => !!e) }))
    .filter((s) => s.entries.length > 0);
}

function entry(r: Row, bindings: Binding[]): Entry | undefined {
  const keys: string[] = [];
  const when = new Set<FocusContext>();
  let global = false;
  for (const b of bindings) {
    if (!r.commands.includes(b.command)) continue;
    if (r.in && b.when?.length && !b.when.includes(r.in)) continue;
    const k = prettyKey(b.key);
    if (!keys.includes(k)) keys.push(k);
    if (b.when?.length) b.when.forEach((w) => when.add(w));
    else global = true;
  }
  if (!keys.length) return undefined;
  // ⌘1–⌘9: the nine tab jumps are one line, and only its ends are worth printing
  const shown = r.range && keys.length > 2 ? [`${keys[0]}–${keys[keys.length - 1]}`] : keys;
  return { label: r.label, keys: shown, when: global ? [] : r.in ? [r.in] : [...when] };
}
