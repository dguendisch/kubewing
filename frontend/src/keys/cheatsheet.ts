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
      row("local terminal on the pane's context and namespace, below / to the right", "terminal.splitDown", "terminal.splitRight"),
      row("close pane", "pane.close"),
      row("maximize pane / show all again", "pane.toggleMaximize"),
      row("name the pane (also double-click its header; empty = none)", "pane.rename"),
      row("next / previous pane", "pane.focusNext", "pane.focusPrev"),
      row("pane left / right", "pane.focusLeft", "pane.focusRight"),
      row("pane above / below", "pane.focusUp", "pane.focusDown"),
      row("move the pane's divider left / right (at the tab's edge: the other one)", "pane.resizeLeft", "pane.resizeRight"),
      row("move the pane's divider up / down", "pane.resizeUp", "pane.resizeDown"),
    ],
  },
  {
    title: "tabs",
    rows: [
      row("new tab", "tab.new"),
      row("close tab", "tab.close"),
      row("name the tab (also double-click it; empty = none)", "tab.rename"),
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
      row("metrics on / off: CPU and memory of pods and nodes (kubectl top)", "view.toggleMetrics"),
      row("requests / limits of the pods on each node on / off (kubectl describe node)", "view.toggleAllocation"),
      row("record changes on / off (diff steps through versions)", "history.toggleRecording"),
      row("leave the filter bar (the field's previous value comes back)", "filter.blur"),
      row("next / previous row", "row.down", "row.up"),
      row("page down / up", "row.pageDown", "row.pageUp"),
      row("first / last row", "row.first", "row.last"),
      row("mark / unmark the row (also ⌘-click)", "mark.toggle"),
      row("mark from the anchor down / up (also ⇧-click)", "mark.down", "mark.up"),
      row("mark a page down / up", "mark.pageDown", "mark.pageUp"),
      row("mark to the first / last row", "mark.first", "mark.last"),
      row("mark all rows shown", "mark.all"),
    ],
  },
  {
    title: "object",
    rows: [
      row("view YAML (in place: esc back to the table)", "detail.open"),
      row("view YAML in a split to the right (to compare; esc closes it)", "detail.openSplit"),
      row("diff last change", "object.diff"),
      row("copy the text selected in a cell, else the name", "table.copy"),
      row("clear the cell's text selection, then the marks", "table.clearSelection"),
      row("copy name (unbound by default: ⌘C without a selection, or the row menu)", "object.copyName"),
      row("copy cell… (right-click: the cell clicked)", "object.copyCell"),
      row("describe", "object.describe"),
      row("describe in a split to the right", "object.describeSplit"),
      row("edit YAML", "object.edit"),
      row("edit YAML in a split to the right", "object.editSplit"),
      row("logs of the row's pods… (⌥ for the whole pane)", "object.logs", "view.logs"),
      row("exec shell", "object.exec"),
      row("debug container…", "object.debug"),
      row("node shell… (the row's node, or any)", "object.opsPod"),
      row("port-forward…", "object.portForward"),
      row("label… / annotate… (key=value sets, key- removes)", "object.label", "object.annotate"),
      row("scale…", "object.scale"),
      row("rollout restart…", "object.restart"),
      row("delete…", "object.delete"),
      row("all actions for the row", "object.menu"),
      row("run the highlighted action", "menu.run"),
      row("jump to cluster / namespace / owner / owned", "object.jump"),
      row("events of the row (⌘← back)", "object.events"),
      row("jump into a split below", "menu.runSplit"),
      row("open a jump's cluster in a new tab", "menu.runTab"),
      row("back / forward (jumps, ⌘O)", "history.back", "history.forward"),
    ],
  },
  {
    title: "time-travel",
    rows: [
      row("into the past / back to live (starts recording)", "travel.toggle"),
      row("previous / next change of the pane's rows", "travel.prev", "travel.next"),
      row("one minute back / forward", "travel.back", "travel.forward"),
      row("to the start of the recording", "travel.start"),
      row("back to live", "travel.live"),
      row("history of the field under the cursor (YAML)", "travel.field"),
    ],
  },
  {
    title: "detail view",
    rows: [
      row("back to YAML", "detail.showYaml"),
      row("toggle diff", "detail.toggleDiff"),
      row("re-run describe", "detail.refresh"),
      rowIn("detail", "edit YAML", "object.edit"),
      rowIn("detail", "jump: what the field at the cursor refers to, then namespace / owner / owned (⌘-click a marked value: straight there)", "object.jump"),
      rowIn("detail", "events of the object", "object.events"),
      row("wrap long lines on / off", "detail.toggleWrap"),
      row("next / previous change (diff)", "diff.next", "diff.prev"),
      row("older / newer version (diff)", "diff.older", "diff.newer"),
      row("filter: field under cursor == / != its value", "filter.fromDetail", "filter.fromDetailNot"),
      row("decode the value under the cursor (base64, brotli, gzip, JWT, certificate…); in it: deeper", "detail.decode"),
      row("up a decoded level; at the top back to the table, or close the split", "detail.close"),
    ],
  },
  {
    title: "edit",
    rows: [
      row("preview the change (server dry run), then apply", "edit.submit"),
      row("back to editing / close", "edit.back"),
      rowIn("edit", "jump from the field at the cursor (into a split to the right; ⌘-click a marked value too)", "object.jump"),
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
    title: "logs",
    rows: [
      row("scroll down / up a line", "logs.lineDown", "logs.lineUp"),
      row("page down / up", "logs.pageDown", "logs.pageUp"),
      row("first / latest line", "logs.top", "logs.bottom"),
      row("filter the lines (fzf-like; !x excludes, ^x / x$ anchor, a | b either)", "logs.focusFilter"),
      row("leave the filter", "logs.blurFilter"),
      row("timestamps on / off", "logs.toggleTimestamps"),
      row("clear the buffer", "logs.clear"),
      row("find", "logs.find"),
      row("next / previous match", "logs.findNext", "logs.findPrev"),
      row("close find", "logs.findClose"),
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
      row("open a cluster: recent, gardenctl, dashboard URL, kubeconfig file", "cluster.open"),
      row("switch the pane between a Gardener shoot and its control plane", "cluster.otherPlane"),
      row("reconnect the pane's context (fresh connection and lists)", "source.reconnect"),
      row("list everything in a namespace again (open it as resource all)", "source.refresh"),
      row("edit the settings (config.yaml), the reference beside them", "config.edit"),
      row("reload the config", "config.reload"),
      row("check for updates (unbound: the app menu has it)", "update.check"),
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
