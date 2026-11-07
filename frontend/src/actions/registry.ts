import { create } from "zustand";
import { defaultBindings, prettyKey, type Binding, type CommandId } from "../keys/keymap";
import type { MarkedRow, RowInfo, SafetyRule } from "../transport/types";

/**
 * Every operation on a table row, in menu order. The context menu (⌘⏎,
 * right-click) is generated from this list, and its shortcuts come from the
 * live keymap, so a new row action only needs an entry here (a unit test
 * fails for object.* commands that have none). Places the pane switches
 * to are in the jump menu instead (jump to…), events included.
 *
 * `available` only drives the display: Go re-checks everything (safety
 * policy, object identity) when the command runs.
 */
export interface RowAction {
  command: CommandId;
  /** Or per row (the diff says how many changes it steps through). */
  label: string | ((row: RowInfo) => string);
  group: "view" | "act" | "danger";
  /** true, or why the action is unavailable for this row. */
  available: (row: RowInfo, rule: SafetyRule | undefined) => true | string;
  /** Mutations: refused on read-only contexts. */
  mutates?: boolean;
  /** The same in a split to the right: not an entry of its own, its shortcut is a hint on this one (and ⇧⏎ in the menu runs it). */
  split?: CommandId;
  /** With rows marked, it acts on them (else on the cursor row). The rest always act on the cursor row. */
  multi?: true | ((r: MarkedRow) => boolean);
  /** What a multi action says with marks ("delete 5…"); n = the rows it applies to. */
  multiLabel?: (n: number) => string;
}

const live = (r: RowInfo) => (r.deleted ? "deleted" : true);
const onNode = (r: RowInfo) => (r.deleted ? "deleted" : r.pod || r.kind === "Node" ? true : `needs a node or pod, not ${r.kind.toLowerCase()}`);
const pod = (r: RowInfo) => (r.deleted ? "deleted" : r.pod ? true : `needs a pod, not ${r.kind.toLowerCase()}`);
const forwardable = (r: RowInfo) => (r.deleted ? "deleted" : r.pod || r.service ? true : `needs a pod or service, not ${r.kind.toLowerCase()}`);
const scalable = (r: RowInfo) => (r.deleted ? "deleted" : r.replicas !== undefined ? true : `${r.kind.toLowerCase()} has no replicas`);
const restartable = (r: RowInfo) => (r.deleted ? "deleted" : r.restart ?? true);

export const rowActions: RowAction[] = [
  { command: "detail.open", label: "view YAML", group: "view", available: () => true, split: "detail.openSplit" },
  { command: "object.edit", label: "edit YAML", group: "view", available: live, mutates: true, split: "object.editSplit" },
  { command: "object.describe", label: "describe", group: "view", available: live, split: "object.describeSplit" },
  {
    command: "object.diff",
    // with recorded history the diff steps through every kept change ([ / ])
    label: (r) => (r.changes && r.changes > 1 ? `diff changes (${r.changes})` : "diff last change"),
    group: "view",
    available: (r) => (r.hasPrev ? true : "no change seen yet"),
  },
  { command: "object.copyName", label: "copy name", group: "view", available: () => true, multi: true, multiLabel: (n) => `copy ${n} names` },
  { command: "object.copyCell", label: "copy cell…", group: "view", available: () => true },
  // read-only and metadata only: also on tombstones (the last state still has its owners)
  { command: "object.jump", label: "jump to…", group: "view", available: () => true },
  {
    command: "object.logs", label: "logs…", group: "view", available: (r) => (r.deleted ? "deleted" : r.logs ? true : "no pods to tail"),
    multi: (r) => !!r.logs, multiLabel: (n) => `logs of ${n}…`,
  },
  { command: "object.exec", label: "exec shell", group: "act", available: pod, mutates: true },
  { command: "object.debug", label: "debug container…", group: "act", available: pod, mutates: true, multi: (r) => r.kind === "Pod", multiLabel: (n) => `debug containers in ${n} pods…` },
  { command: "object.opsPod", label: "node shell…", group: "act", available: onNode, mutates: true },
  { command: "object.portForward", label: "port-forward…", group: "act", available: forwardable },
  { command: "object.label", label: "label…", group: "act", available: live, mutates: true, multi: true, multiLabel: (n) => `label ${n}…` },
  { command: "object.annotate", label: "annotate…", group: "act", available: live, mutates: true, multi: true, multiLabel: (n) => `annotate ${n}…` },
  {
    command: "object.scale", label: (r) => (r.replicas !== undefined ? `scale… (${r.replicas})` : "scale…"), group: "act", available: scalable, mutates: true,
    multi: (r) => r.replicas !== undefined, multiLabel: (n) => `scale ${n}…`,
  },
  {
    command: "object.restart", label: "rollout restart…", group: "act", available: restartable, mutates: true,
    multi: (r) => !r.restart, multiLabel: (n) => `rollout restart ${n}…`,
  },
  { command: "object.delete", label: "delete…", group: "danger", available: live, mutates: true, multi: true, multiLabel: (n) => `delete ${n}…` },
];

export interface MenuItem {
  command: CommandId;
  label: string;
  group: RowAction["group"];
  /** Shortcut in the table, for display (e.g. "⇧D"); undefined if unbound. */
  shortcut?: string;
  /** The split variant (RowAction.split) and its shortcut in the table, for the hint. */
  split?: CommandId;
  splitShortcut?: string;
  /** Why it's disabled; undefined = enabled. */
  disabled?: string;
  /** With rows marked: true = acts on them, false = on the cursor row only. */
  multi?: boolean;
}

/** Items of the open context menu (read by the dispatcher for ⏎ / j / k). */
export const useMenu = create<{ items: MenuItem[]; row?: RowInfo; marked?: MarkedRow[] }>(() => ({ items: [] }));

/**
 * The menu for one row, or with rows marked (marked: them) for those: a
 * multi action applies to the marked rows it fits (none: disabled, with
 * why), the others to the cursor row. Pure.
 */
export function menuFor(row: RowInfo, rule: SafetyRule | undefined, bindings: Binding[] = defaultBindings, marked?: MarkedRow[]): MenuItem[] {
  return rowActions.map((a) => {
    const many = !!marked?.length && !!a.multi;
    const fits = many ? marked!.filter((r) => a.multi === true || (a.multi as (r: MarkedRow) => boolean)(r)).length : 0;
    let ok: true | string = many ? (fits ? true : `none of the ${marked!.length} marked fits`) : a.available(row, rule);
    if (ok === true && a.mutates && rule?.readOnly) ok = "read-only context";
    const key = (c: CommandId) => {
      const b = bindings.find((x) => x.command === c && (!x.when?.length || x.when.includes("table")));
      return b && prettyKey(b.key);
    };
    const label = many && a.multiLabel ? a.multiLabel(fits || marked!.length) : typeof a.label === "function" ? a.label(row) : a.label;
    return {
      command: a.command, label, group: a.group, shortcut: key(a.command), split: a.split, splitShortcut: a.split && key(a.split), disabled: ok === true ? undefined : ok,
      multi: marked?.length ? many : undefined,
    };
  });
}
