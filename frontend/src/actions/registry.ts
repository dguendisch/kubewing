import { create } from "zustand";
import { defaultBindings, prettyKey, type Binding, type CommandId } from "../keys/keymap";
import type { RowInfo, SafetyRule } from "../transport/types";

/**
 * Every operation on a table row, in menu order. The context menu (⌘⏎,
 * right-click) is generated from this list, and its shortcuts come from the
 * live keymap, so a new row action only needs an entry here (a unit test
 * fails for object.* commands that have none).
 *
 * `available` only drives the display: Go re-checks everything (safety
 * policy, object identity) when the command runs.
 */
export interface RowAction {
  command: CommandId;
  label: string;
  group: "view" | "act" | "danger";
  /** true, or why the action is unavailable for this row. */
  available: (row: RowInfo, rule: SafetyRule | undefined) => true | string;
  /** Mutations: refused on read-only contexts. */
  mutates?: boolean;
}

const live = (r: RowInfo) => (r.deleted ? "deleted" : true);
const pod = (r: RowInfo) => (r.deleted ? "deleted" : r.pod ? true : `needs a pod, not ${r.kind.toLowerCase()}`);

export const rowActions: RowAction[] = [
  { command: "detail.open", label: "view YAML", group: "view", available: () => true },
  { command: "object.diff", label: "diff to previous version", group: "view", available: (r) => (r.hasPrev ? true : "no previous version since watch start") },
  { command: "object.describe", label: "describe", group: "view", available: live },
  { command: "object.exec", label: "exec shell", group: "act", available: pod, mutates: true },
  { command: "object.portForward", label: "port-forward…", group: "act", available: pod },
  { command: "object.delete", label: "delete…", group: "danger", available: live, mutates: true },
];

export interface MenuItem {
  command: CommandId;
  label: string;
  group: RowAction["group"];
  /** Shortcut in the table, for display (e.g. "⇧D"); undefined if unbound. */
  shortcut?: string;
  /** Why it's disabled; undefined = enabled. */
  disabled?: string;
}

/** Items of the open context menu (read by the dispatcher for ⏎ / j / k). */
export const useMenu = create<{ items: MenuItem[]; row?: RowInfo }>(() => ({ items: [] }));

/** The menu for one row. Pure. */
export function menuFor(row: RowInfo, rule: SafetyRule | undefined, bindings: Binding[] = defaultBindings): MenuItem[] {
  return rowActions.map((a) => {
    let ok = a.available(row, rule);
    if (ok === true && a.mutates && rule?.readOnly) ok = "read-only context";
    const b = bindings.find((x) => x.command === a.command && (!x.when?.length || x.when.includes("table")));
    return { command: a.command, label: a.label, group: a.group, shortcut: b && prettyKey(b.key), disabled: ok === true ? undefined : ok };
  });
}
