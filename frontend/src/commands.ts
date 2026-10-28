import type { CommandId } from "./keys/keymap";
import { bridge, paneData, setUI, useColumns, usePortForwards, useUI } from "./store/store";
import type { ActionKind, ColumnSpec, DebugOptions, JumpTarget, Launch, LogsOptions, OpsPodOptions, Pending } from "./transport/types";
import { useMenu } from "./actions/registry";
import { jumpable, useJump } from "./actions/jump";
import { paneIds } from "./store/layout";
import { celFromLeaf, yamlLeaf } from "./complete/cel";
import { cursorOf, diffNavOf, useDiffRange, viewSlot } from "./editor/Viewer";
import * as S from "./store/state";
import { setTimeline, shifted, useTimelines } from "./store/travel";
import { containerChoices, initialChoice, moveChoice, needsPicker } from "./components/containers";
import { moveShown } from "./components/columnsForm";
import { cellChoices, initialCell, wholeRow } from "./grid/cells";
import { rowAt } from "./grid/rowcache";
import { selectedText, setTextSel, useTextSel } from "./grid/textsel";
import { logBuffers } from "./logs/buffer";

/**
 * The single command dispatcher. Keyboard shortcuts, native menu
 * accelerators and UI buttons all end up here.
 */
export function dispatch(cmd: CommandId, opts: { repeat?: boolean } = {}) {
  if (cmd.startsWith("tab.goto")) return setUI((x) => S.gotoTab(x, Number(cmd.slice(8))));
  const s = useUI.getState();
  const pane = S.focusedPane(s);
  // a decoded value is in the object view's place: these act on the object (or on the table)
  if (pane.object?.decode && !s.overlay && decodeBlocked.has(cmd)) return;
  const total = pane.serverId ? paneData.get(pane.serverId).total : 0;
  const page = 20;
  switch (cmd) {
    case "pane.splitRight":
      return setUI((x) => S.splitPane(x, "row"));
    case "pane.splitDown":
      return setUI((x) => S.splitPane(x, "column"));
    case "pane.close":
      return closePaneAsking(pane.id);
    case "pane.focusNext":
      return setUI((x) => S.cyclePane(x, 1));
    case "pane.focusPrev":
      return setUI((x) => S.cyclePane(x, -1));
    case "pane.focusLeft":
      return setUI((x) => S.focusDirection(x, "left"));
    case "pane.focusRight":
      return setUI((x) => S.focusDirection(x, "right"));
    case "pane.focusUp":
      return setUI((x) => S.focusDirection(x, "up"));
    case "pane.focusDown":
      return setUI((x) => S.focusDirection(x, "down"));
    case "pane.toggleMaximize":
      return setUI(S.toggleMaximize);
    case "pane.rename":
      return setUI((x) => S.renamePane(x));
    case "tab.rename":
      return setUI((x) => S.renameTab(x));
    case "tab.new":
      return setUI(S.newTab);
    case "tab.close": {
      // a tab with splits is work: losing it to a stray ⌘W would be expensive; so is an edit not written
      const tab = S.activeTab(s);
      const edits = paneIds(tab.layout).some((id) => S.unsaved(s.panes[id]));
      if (paneIds(tab.layout).length < 2 && !edits) return setUI((x) => S.closeTab(x));
      return setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "closeTab", pane: pane.id, tabId: tab.id }));
    }
    case "tab.next":
      return setUI((x) => S.cycleTab(x, 1));
    case "tab.prev":
      return setUI((x) => S.cycleTab(x, -1));
    case "tab.mruNext":
      return setUI((x) => S.switcherStep(x, 1));
    case "tab.mruPrev":
      return setUI((x) => S.switcherStep(x, -1));
    case "tab.switcherCommit":
      return setUI(S.switcherCommit);
    case "tab.switcherCancel":
      return setUI(S.switcherCancel);
    case "filter.focus":
      return setUI((x) => ({ ...x, focus: "filter", filterField: "grep", overlay: undefined }));
    case "filter.focusLabels":
      return setUI((x) => ({ ...x, focus: "filter", filterField: "labels", overlay: undefined }));
    case "filter.focusCel":
      return setUI((x) => ({ ...x, focus: "filter", filterField: "cel", overlay: undefined }));
    case "filter.fromDetail":
    case "filter.fromDetailNot":
      return filterFromDetail(cmd === "filter.fromDetail" ? "==" : "!=");
    case "filter.toggleHealthy":
      return toggleHealthy();
    case "filter.blur":
      return setUI((x) => ({ ...x, focus: "table" }));
    case "row.down":
      if (s.overlay?.kind === "jump") return setUI((x) => moveJump(x, 1));
      if (s.overlay?.kind === "history") return setUI((x) => moveInHistory(x, 1));
      if (s.overlay?.kind === "forwards") return setUI((x) => moveForward(x, 1));
      if (s.overlay?.kind === "menu") return setUI((x) => moveMenu(x, 1));
      if (s.overlay?.kind === "container") return setUI((x) => moveContainer(x, 1));
      if (s.overlay?.kind === "cells") return setUI((x) => moveCell(x, 1));
      if (s.overlay?.kind === "field") return setUI((x) => moveField(x, 1));
      return setUI((x) => S.moveSelection(x, 1, total));
    case "row.up":
      if (s.overlay?.kind === "jump") return setUI((x) => moveJump(x, -1));
      if (s.overlay?.kind === "history") return setUI((x) => moveInHistory(x, -1));
      if (s.overlay?.kind === "forwards") return setUI((x) => moveForward(x, -1));
      if (s.overlay?.kind === "menu") return setUI((x) => moveMenu(x, -1));
      if (s.overlay?.kind === "container") return setUI((x) => moveContainer(x, -1));
      if (s.overlay?.kind === "cells") return setUI((x) => moveCell(x, -1));
      if (s.overlay?.kind === "field") return setUI((x) => moveField(x, -1));
      return setUI((x) => S.moveSelection(x, -1, total));
    case "row.pageDown":
      return setUI((x) => S.moveSelection(x, page, total));
    case "row.pageUp":
      return setUI((x) => S.moveSelection(x, -page, total));
    case "row.first":
      return setUI((x) => S.moveSelection(x, "first", total));
    case "row.last":
      return setUI((x) => S.moveSelection(x, "last", total));
    case "detail.open":
      return openObjectView(pane, { view: "yaml" }, false);
    case "detail.openSplit":
      return openSplitView(pane);
    case "object.diff":
      return openObjectView(pane, { view: "yaml", diff: true }, false);
    case "object.copyName":
      return void copyName(pane);
    case "table.copy":
      return void copySelection(pane);
    case "table.clearSelection":
      if (pane.serverId) setTextSel(pane.serverId, undefined);
      return;
    case "object.copyCell":
      return openCells();
    case "object.menu": {
      const key = selectedKey(pane);
      if (!key) return;
      const at = belowHeader(pane);
      return setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "menu", pane: pane.id, key, index: 0, rowIndex: at ? undefined : pane.selected, at }));
    }
    case "object.jump":
      return openJump();
    case "object.events":
      return void openEvents();
    case "menu.runSplit": {
      const o = s.overlay;
      if (o?.kind === "jump") return void runJump(o.index ?? 0, true);
      // the row menu: a view entry (YAML, diff, describe) opens in a split instead of in place, edit YAML its editor
      if (o?.kind !== "menu") return;
      const item = useMenu.getState().items[o.index ?? 0];
      if (!item || item.disabled || !(splitViews.has(item.command) || item.split)) return;
      setUI(S.closeOverlay);
      if (!splitViews.has(item.command)) return dispatch(item.split!);
      return openObjectView(S.focusedPane(useUI.getState()), splitViews.get(item.command)!, true);
    }
    case "history.back":
    case "history.forward":
      return void moveHistory(cmd === "history.back" ? "back" : "forward");
    case "menu.run": {
      const o = s.overlay;
      if (o?.kind === "jump") return void runJump(o.index ?? 0, false);
      if (o?.kind === "history") return void pickHistory(o.index ?? 0);
      if (o?.kind === "container") return void pickContainer(o.containers?.[o.index ?? 0]?.name);
      if (o?.kind === "cells") return void copyCell(o.index ?? 0);
      if (o?.kind === "field") return void pickField(o.pane, o.field?.changes[o.index ?? 0]?.at);
      if (o?.kind !== "menu") return;
      const item = useMenu.getState().items[o.index ?? 0];
      if (!item || item.disabled) return;
      // the jump menu and the cell picker replace this one at its anchor (they close it themselves)
      if (!S.replacesMenu(item.command)) setUI(S.closeOverlay);
      return dispatch(item.command); // runs on the selected row, exactly like its shortcut
    }
    case "detail.showYaml":
      return setUI((x) => S.setObject(x, pane.id, (o) => ({ ...o, view: "yaml", diff: false, version: undefined })));
    case "object.describe":
      // from the table, or switching an object view to describe
      if (pane.object) return setUI((x) => S.setObject(x, pane.id, (o) => ({ ...o, view: "describe", diff: false, describeGen: (o.describeGen ?? 0) + 1 })));
      return openObjectView(pane, { view: "describe" }, false);
    case "object.describeSplit":
      return openObjectView(pane, { view: "describe" }, true);
    case "object.exec":
      return void prepareAction("exec");
    case "object.edit":
      return void openEdit();
    case "object.editSplit":
      return void openEdit(true);
    case "edit.submit":
      return void submitEdit();
    case "edit.back": {
      const e = pane.object?.edit;
      if (!e) return;
      if (e.preview) return setUI((x) => S.setEdit(x, pane.id, (d) => ({ ...d, preview: undefined })));
      // changes are work: the first esc only asks
      if (e.yaml !== e.opened && !e.discarding) return setUI((x) => S.setEdit(x, pane.id, (d) => ({ ...d, discarding: true })));
      return setUI((x) => closeEditor(x, pane.id)); // the session is closed once no pane holds it (store)
    }
    case "object.debug":
      return void prepareAction("debug");
    case "object.opsPod":
      return void openOpsPod();
    case "object.portForward": {
      const key = selectedKey(pane);
      if (!key) return;
      return setUI((x) => S.openOverlay(x, { kind: "portforward", pane: pane.id, key }));
    }
    case "object.logs":
      return openLogsDialog(pane, false);
    case "view.logs":
      return openLogsDialog(pane, true);
    case "logs.focusFilter":
      return setUI((x) => (x.focus === "logs" ? { ...x, focus: "logsfilter" } : x));
    case "logs.blurFilter":
      return setUI((x) => (x.focus === "logsfilter" ? { ...x, focus: "logs" } : x));
    case "logs.toggleTimestamps":
      return setUI((x) => S.toggleLogTimestamps(x, pane.id));
    case "logs.clear":
      if (pane.logs) logBuffers.clear(pane.logs.session);
      return;
    case "logs.find":
      return setUI(S.openLogFind);
    case "logs.findClose":
      return setUI(S.closeLogFind);
    case "logs.findNext":
    case "logs.findPrev": {
      const f = pane.logs?.find;
      if (!pane.logs || !f?.query) return setUI(S.openLogFind);
      return finders.get(pane.logs.session)?.(cmd === "logs.findNext" ? "next" : "prev");
    }
    case "logs.lineDown":
    case "logs.lineUp":
    case "logs.pageDown":
    case "logs.pageUp":
    case "logs.top":
    case "logs.bottom":
      if (pane.logs) scrollers.get(pane.logs.session)?.(cmd.slice(5) as LogScroll);
      return;
    case "view.columns":
      return void openColumns(pane.id);
    case "history.toggleRecording":
      return void toggleRecording(pane.id);
    case "travel.toggle":
      return void travel(pane.id, paneData.get(pane.serverId ?? "").status?.at ? { live: true } : { enter: true });
    case "travel.prev":
    case "travel.next":
      return void travel(pane.id, { step: cmd === "travel.prev" ? -1 : 1 });
    case "travel.back":
    case "travel.forward":
      return void travel(pane.id, { shift: cmd === "travel.back" ? -60_000 : 60_000 });
    case "travel.start":
      return void travel(pane.id, { start: true });
    case "travel.live":
      if (pane.serverId && useTextSel.getState()[pane.serverId]) {
        // Esc clears a text selection first, as in the live table
        return setTextSel(pane.serverId, undefined);
      }
      return void travel(pane.id, { live: true });
    case "travel.field":
      return void openFieldHistory();
    case "portforward.list":
      return setUI((x) => (x.overlay?.kind === "forwards" ? S.closeOverlay(x) : S.openOverlay(S.closeOverlay(x), { kind: "forwards", pane: pane.id, index: 0 })));
    case "portforward.stop": {
      const f = usePortForwards.getState().list[s.overlay?.index ?? 0];
      if (f) void bridge().portForwardStop(f.id).catch(() => {});
      return;
    }
    case "detail.close":
      // overlays (menus, the cheat sheet …) close; the field list goes back to the object view
      if (s.overlay) return setUI(S.closeOverlay);
      // an object view: a decoded level up; at the top, back to the table (in place) or the split closes
      if (pane.object?.decode) return setUI((x) => S.decodeUp(x, pane.id));
      if (pane.object) return setUI((x) => S.leaveObject(x, pane.id, opts.repeat));
      return;
    case "detail.decode":
      return openDecode(pane);
    case "detail.toggleDiff":
      // in describe: diff against the previous describe; elsewhere the object diff (from the newest version)
      return setUI((x) => S.setObject(x, pane.id, (o) => ({ ...o, diff: !o.diff, version: undefined })));
    case "diff.next":
    case "diff.prev":
      return diffNavOf(pane.object?.edit ? `${pane.id}/edit` : viewSlot(pane.id, !!pane.object?.decode)).go?.(cmd === "diff.next" ? "next" : "previous");
    case "diff.older":
    case "diff.newer":
      return setUI((x) => S.stepVersion(x, pane.id, cmd === "diff.older" ? -1 : 1, useDiffRange.getState()[viewSlot(pane.id, !!pane.object?.decode)]));
    case "detail.toggleWrap":
      return setUI((x) => ({ ...x, wrap: !x.wrap }));
    case "detail.refresh":
      // re-run describe: the last run becomes the baseline of the diff
      return setUI((x) => S.setObject(x, pane.id, (o) => (o.view === "describe" ? { ...o, describeGen: (o.describeGen ?? 0) + 1 } : o)));
    case "source.open":
      return setUI((x) => S.openOverlay(x, { kind: "open", pane: pane.id }));
    case "config.reload":
      return void bridge().reloadConfig().catch(() => {}); // applied via the kw:config event
    case "help.toggle":
      // from an open menu or port-forward list: that overlay closes, the sheet replaces it
      return setUI((x) => (x.overlay?.kind === "help" ? S.closeOverlay(x) : S.openOverlay(S.closeOverlay(x), { kind: "help", pane: pane.id })));
    case "object.delete":
      return void prepareAction("delete");
    case "confirm.accept":
      if (s.overlay?.kind === "closeTab") {
        const i = s.tabs.findIndex((t) => t.id === s.overlay!.tabId);
        return setUI((x) => (i < 0 ? S.closeOverlay(x) : S.closeTab(S.closeOverlay(x), i)));
      }
      if (s.overlay?.kind === "closePane") {
        const id = s.overlay.pane;
        return setUI((x) => S.closePane(S.closeOverlay(x), id));
      }
      return void runConfirmed();
    case "confirm.cancel":
      // a confirmed edit goes back to its preview (the pane still has it), not away
      return setUI(S.closeOverlay);
    case "term.find":
      return setUI(S.openFind);
    case "term.findClose":
      return setUI(S.closeFind);
    case "term.findNext":
    case "term.findPrev": {
      // from the shell too (⌘G), with the bar's last query; nothing to find yet: open the bar
      const f = pane.term?.find;
      if (!pane.term || !f?.query) return setUI(S.openFind);
      return finders.get(pane.term.session)?.(cmd === "term.findNext" ? "next" : "prev");
    }
  }
}

/** Commands of the object view that don't apply to a decoded value (its keys are the object view's). */
const decodeBlocked = new Set<CommandId>(["object.describe", "object.edit", "object.jump", "object.events", "detail.showYaml", "detail.toggleDiff", "detail.refresh", "filter.fromDetail", "filter.fromDetailNot", "travel.field"]);

/** Row menu entries ⇧⏎ opens in a split: the views of the object. */
const splitViews = new Map<CommandId, Pick<S.ObjectView, "view" | "diff">>([
  ["detail.open", { view: "yaml" }],
  ["object.diff", { view: "yaml", diff: true }],
  ["object.describe", { view: "describe" }],
]);

/** The table's selected row as an object view: over the table (⏎), or in a split to the right (⇧⏎). */
function openObjectView(pane: S.PaneState, v: Pick<S.ObjectView, "view" | "diff">, inSplit: boolean) {
  const key = selectedKey(pane);
  if (!key) return;
  // already in an object view (the native menu's View YAML, Diff): it switches to that view
  if (pane.object && !inSplit) return setUI((x) => S.setObject(S.closeOverlay(x), pane.id, (o) => ({ ...o, ...v, version: undefined, decode: undefined, describeGen: v.view === "describe" ? (o.describeGen ?? 0) + 1 : o.describeGen })));
  const object: S.ObjectView = { key, ...v };
  setUI((x) => (inSplit ? S.openObjectSplit(S.closeOverlay(x), object, pane.id) : S.openObject(S.closeOverlay(x), pane.id, object)));
}

/**
 * ⇧⏎: in the table, the selected row's YAML in a split; in an object view,
 * what it shows (the object, or the decoded level) in a split of its own,
 * to compare with what comes next here.
 */
function openSplitView(pane: S.PaneState) {
  if (!pane.object) return openObjectView(pane, { view: "yaml" }, true);
  if (pane.object.edit) return;
  setUI((x) => S.openObjectSplit(x, pane.object!, pane.id));
}

/** Closing a pane: one with an edit not written yet asks first. */
function closePaneAsking(paneId: string) {
  const p = useUI.getState().panes[paneId];
  if (!S.unsaved(p)) return setUI((x) => S.closePane(x, paneId));
  setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "closePane", pane: paneId }));
}

/** The editor goes: back to the object view it was opened from, or (e in the table) to the table. */
function closeEditor(s: S.UIState, paneId: string): S.UIState {
  const o = s.panes[paneId]?.object;
  if (!o?.edit) return s;
  if (o.viaEdit) return S.leaveObject(S.setObject(s, paneId, ({ edit: _, viaEdit: __, ...x }) => x), paneId);
  return S.setObject(s, paneId, ({ edit: _, ...x }) => x);
}

/** Per terminal/log session: steps to the next/previous find match (registered by the open xterm). */
export const finders = new Map<string, (dir: "next" | "prev") => void>();

export type LogScroll = "lineDown" | "lineUp" | "pageDown" | "pageUp" | "top" | "bottom";
/** Per log session: scrolls its view (registered by the open xterm). */
export const scrollers = new Map<string, (to: LogScroll) => void>();

/**
 * ⌘L / ⌥⌘L: the log dialog for a row's pods (whole = every pod the pods pane
 * shows); it starts the tail (startLogs).
 */
function openLogsDialog(pane: S.PaneState, whole: boolean) {
  if (!pane.serverId || pane.term || pane.logs) return;
  const key = whole ? undefined : selectedKey(pane);
  if (!whole && !key) return;
  setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "logs", pane: pane.id, key, whole }));
}

/**
 * The log dialog's submit: tails the pods with its options, in a new pane
 * below. Read-only, so no safety prepare — like describe and port-forward. A
 * pane that can't produce logs (no pods) is refused by Go. Returns the error
 * to show in the dialog, if any.
 */
export async function startLogs(paneId: string, key: string | undefined, whole: boolean, opts: LogsOptions, timestamps: boolean): Promise<string | undefined> {
  const pane = useUI.getState().panes[paneId];
  if (!pane?.serverId) return "the pane is gone";
  try {
    const r = await bridge().logsStart(pane.serverId, key ?? "", whole, opts);
    const logs: S.Logs = { session: r.session, title: r.title, context: r.context, filter: "", timestamps, follow: opts.follow, prefix: true };
    setUI((x) => S.openLogs(x, logs, pane.id));
  } catch (e) {
    return errorText(e);
  }
}

/**
 * = / ! in the YAML view: the field under the cursor, compared with its
 * value, becomes the pane's CEL filter, applied at once (it's complete, so
 * there's nothing to preview). The detail view closes onto the result.
 */
function filterFromDetail(op: "==" | "!=") {
  const pane = S.focusedPane(useUI.getState());
  const o = pane.object;
  if (!o || o.view === "describe" || o.diff || o.decode || o.edit) return;
  const cur = cursorOf(pane.id);
  if (cur.text === undefined) return;
  const leaf = yamlLeaf(cur.text.split("\n"), cur.line);
  const expr = leaf && celFromLeaf(leaf, op);
  if (!expr) return flash(pane.id, "no value on this line to filter by", true);
  // the table the object came from takes the filter, and shows it
  const table = o.split ? o.from : pane.id;
  const t = table ? useUI.getState().panes[table] : undefined;
  if (!t || t.leased || (o.split && t.serverId !== pane.serverId)) return flash(pane.id, "the table this object came from is gone", true);
  if (o.split) setUI((x) => S.focusPane(x, t.id));
  else setUI((x) => S.leaveObject(x, pane.id));
  void applySpec(t.id, { ...t.spec, filter: expr });
}

/** h: hides (or shows again) the healthy pods and workloads (see S.healthKinds). */
function toggleHealthy() {
  const pane = S.focusedPane(useUI.getState());
  if (pane.term) return;
  if (pane.kind && !S.hasHealth(pane.kind) && !pane.spec.hideHealthy)
    return flash(pane.id, "hiding healthy works on pods, deployments, statefulsets, replicasets and daemonsets", true);
  void applySpec(pane.id, { ...pane.spec, hideHealthy: !pane.spec.hideHealthy });
}

/** ⌘C in the table: the text selected in a cell of the row (an age cell: its timestamp), else the name. */
async function copySelection(pane: S.PaneState) {
  if (!pane.serverId) return;
  const d = paneData.get(pane.serverId);
  const sel = useTextSel.getState()[pane.serverId];
  if (!sel) return copyName(pane);
  const text = selectedText(sel, d.rows.get(sel.key), d.columns);
  // the cell changed under the selection (a live update): copying the name instead would surprise
  if (text === undefined) {
    setTextSel(pane.serverId, undefined);
    return flash(pane.id, "nothing copied: the selected cell changed", true);
  }
  try {
    await bridge().copyText(text);
    flash(pane.id, `copied ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

/** The selected object's name (as kubectl takes it): "copy name" in the ⌘⏎ menu, ⌘C without a text selection. */
async function copyName(pane: S.PaneState) {
  const key = selectedKey(pane);
  if (!key || !pane.serverId) return;
  try {
    const { name } = await bridge().rowInfo(pane.serverId, key);
    await bridge().copyText(name);
    flash(pane.id, `copied ${name}`);
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

/** The column copied last: ⌘⇧C highlights it again, so ⌘⇧C ⏎ copies the same cell of the next row. */
let lastCell: string | undefined;

/**
 * ⌘⇧C, or "copy cell…" in the ⌘⏎ menu (opened by right-clicking a cell,
 * that cell is highlighted): which of the selected row's cells to copy. The
 * cells are the ones the table holds, so no bridge call; opened from the
 * menu it takes the menu's place, at the same anchor.
 */
function openCells() {
  const s = useUI.getState();
  const pane = S.focusedPane(s);
  const key = selectedKey(pane);
  if (!key || !pane.serverId) return;
  const d = paneData.get(pane.serverId);
  const row = rowAt(d, pane.selected);
  if (!row) return;
  const cells = cellChoices(row, d.columns, Date.now());
  const fromMenu = s.overlay?.kind === "menu" ? s.overlay : undefined;
  const index = initialCell(cells, fromMenu?.column ?? lastCell);
  setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "cells", pane: pane.id, key, cells, index, rowIndex: pane.selected, at: fromMenu?.at }));
}

export async function copyCell(index: number) {
  const o = useUI.getState().overlay;
  const c = o?.cells?.[index];
  if (o?.kind !== "cells" || !c || c.disabled) return;
  setUI(S.closeOverlay);
  lastCell = c.label;
  try {
    await bridge().copyText(c.text);
    flash(o.pane, c.label === wholeRow ? "copied the whole row" : `copied ${c.label} ${c.text}`);
  } catch (e) {
    flash(o.pane, errorText(e), true);
  }
}

/**
 * kubewing was launched again from a terminal: a tab on that terminal's
 * kubeconfig, at its current context and namespace (not a copy of this tab).
 */
export function openLaunch(l: Launch) {
  setUI((x) => S.launchTab(x, l.cluster, l.namespace ?? ""));
  if (l.error) flash(S.focusedPane(useUI.getState()).id, `kubeconfig: ${l.error}`, true);
}

/** Shows a short message in a pane's status line (an object view's too); gone after 5 s. */
export function flash(paneId: string, text: string, error = false) {
  const f = { text, error };
  setUI((x) => S.updatePane(x, paneId, (p) => ({ ...p, flash: f })));
  setTimeout(() => setUI((x) => (x.panes[paneId]?.flash === f ? S.updatePane(x, paneId, (p) => ({ ...p, flash: undefined })) : x)), 5000);
}

/**
 * Mutations are two-phase: Go checks the safety policy and issues a token
 * (Prepare), the UI confirms if the rule asks for it, then the token is
 * redeemed. Refusals (read-only context …) show in the pane's status line.
 * An exec into a pod with more than one container it could enter asks which
 * one in between (the default highlighted, so x ⏎ is a plain x).
 */
async function prepareAction(kind: ActionKind) {
  const s = useUI.getState();
  const pane = S.focusedPane(s);
  // in an object view: its object (the native menu, ⌘⌫ there)
  const key = selectedKey(pane);
  if (!pane.serverId || !key) return;
  try {
    const pending = await bridge().prepare(kind, pane.serverId, key);
    if (kind === "debug") return setUI((x) => S.openOverlay(x, { kind: "debug", pane: pane.id, key, pending }));
    if (kind === "exec") {
      const containers = containerChoices((await bridge().rowInfo(pane.serverId, key)).containerInfo ?? []);
      if (needsPicker(containers)) {
        return setUI((x) => S.openOverlay(x, { kind: "container", pane: pane.id, key, pending, containers, index: initialChoice(containers) }));
      }
    }
    await proceed(pane.id, key, pending);
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

/** A prepared action, its container (exec) or options (debug, ops pod, edit) picked: confirm if the rule asks for it, else run. */
async function proceed(paneId: string, key: string | undefined, pending: Pending, container = "", debug?: DebugOptions, ops?: OpsPodOptions, edit?: S.EditState) {
  if (pending.needsConfirm) setUI((x) => S.openOverlay(x, { kind: "confirm", pane: paneId, key, pending, container, debug, ops, edit }));
  else await execute(paneId, pending, container, debug, ops, edit);
}

/**
 * e, from the table or an object view: Go reads the object fresh and opens
 * an edit session (refused on read-only contexts, before anyone types). The
 * editor takes the object view's place; from the table, the object opens
 * over it for that, and closing the editor goes back to the table.
 */
async function openEdit(inSplit = false) {
  const s = useUI.getState();
  const pane = S.focusedPane(s);
  if (pane.object?.edit || (pane.object?.decode && !inSplit)) return;
  const key = pane.object?.key ?? selectedKey(pane);
  const before = pane.object;
  if (!pane.serverId || !key) return;
  try {
    const [es, info] = await Promise.all([bridge().editOpen(pane.serverId, key), bridge().rowInfo(pane.serverId, key)]);
    const now = useUI.getState().panes[pane.id];
    // something else meanwhile (another row, another view; its title loading in doesn't count)
    const moved = before ? now?.object?.key !== key || !!now.object.edit || (!!now.object.decode && !inSplit) : !!now?.object || (now && selectedKey(now)) !== key;
    if (!now || moved) return void bridge().editClose(es.session).catch(() => {});
    const edit: S.EditState = { session: es.session, key, title: `${info.kind} ${info.name}`, opened: es.yaml, yaml: es.yaml };
    // ⇧E: a split of its own, opened in the editor (closing the editor closes the split, as e's goes back to the table)
    if (inSplit) return setUI((x) => S.withEdit(S.openObjectSplit(S.closeOverlay(x), { key, view: "yaml", title: info.name, viaEdit: true }, pane.id), edit));
    if (before) return setUI((x) => S.setObject(x, pane.id, (o) => ({ ...o, edit, title: o.title ?? info.name })));
    setUI((x) => S.openObject(S.closeOverlay(x), pane.id, { key, view: "yaml", title: info.name, edit, viaEdit: true }));
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

/** A failed write: back in the pane's editor (not its preview), with why. */
function reopenEdit(paneId: string, edit: S.EditState) {
  setUI((x) => S.setEdit(x, paneId, () => edit));
}

/**
 * ⌘S / ⌘⏎ in the editor: Go checks the edit and the server dry-runs it; a
 * refusal (bad YAML, webhook, conflict) stays in the editor, else its diff
 * shows. There ⏎ (or ⌘S again) prepares and writes it, confirmed if the
 * context's rule asks for it.
 */
async function submitEdit() {
  const pane = S.focusedPane(useUI.getState());
  const e = pane.object?.edit;
  if (!e || !pane.serverId) return;
  const paneId = pane.id;
  // a result for text that was changed meanwhile is dropped
  const same = (x: S.UIState) => {
    const d = x.panes[paneId]?.object?.edit;
    return d?.session === e.session && d.yaml === e.yaml && !d.preview === !e.preview;
  };
  const fail = (err: unknown) => setUI((x) => (same(x) ? S.setEdit(x, paneId, (d) => ({ ...d, preview: undefined, error: errorText(err), discarding: false })) : x));
  if (!e.preview) {
    try {
      const preview = await bridge().editCheck(e.session, e.yaml);
      if (preview.noChange) return fail("the server would store nothing new (status, for one, isn't changed by an edit)");
      setUI((x) => (same(x) ? S.setEdit(x, paneId, (d) => ({ ...d, preview, error: undefined, discarding: false })) : x));
    } catch (err) {
      fail(err);
    }
    return;
  }
  let pending: Pending;
  try {
    pending = await bridge().prepare("edit", pane.serverId, e.key);
  } catch (err) {
    return fail(err);
  }
  if (!same(useUI.getState())) return;
  await proceed(paneId, e.key, pending, "", undefined, undefined, e);
}

/**
 * ⌘⌥O, from anywhere: the ops pod dialog on the focused pane's context.
 * A selected row that stands for a node (a node, a pod's node) prefills it;
 * nothing selected (a terminal pane, an empty table) starts empty.
 */
/** The column dialog of a pane: its choices are loaded first (a pane still opening has none yet). */
export async function openColumns(paneId: string) {
  const p = useUI.getState().panes[paneId];
  if (!p?.serverId || !p.type) return;
  const columns = await bridge()
    .columnChoices(p.serverId)
    .catch(() => undefined);
  if (!columns) return;
  setUI((x) => S.openOverlay(S.closeOverlay(S.focusPane(x, paneId)), { kind: "columns", pane: paneId, columns }));
}

/**
 * A header dragged to another place in the table: the type's columns are
 * saved in the new order, so every pane of the type follows (like the
 * column dialog). A refusal shows in the status line.
 */
export async function moveColumn(paneId: string, from: number, to: number) {
  const p = useUI.getState().panes[paneId];
  if (!p?.serverId || !p.type) return;
  const type = p.type;
  try {
    const choices = await bridge().columnChoices(p.serverId);
    const shown = choices.options.filter((o) => o.shown && !o.missing).map((o) => o.name);
    const next = moveShown(shown, useColumns.getState().types[type]?.columns, choices.defaults, from, to);
    if (next !== undefined) await bridge().setTypeColumns(type, next);
  } catch (e) {
    flash(paneId, `moving the column failed: ${errorText(e)}`, true);
  }
}

/** The column dialog's ⏎: Go validates and saves; the error, if any, is shown in the dialog. */
export async function submitColumns(type: string, columns: ColumnSpec[] | null): Promise<string | undefined> {
  try {
    await bridge().setTypeColumns(type, columns);
  } catch (e) {
    return String((e as Error).message ?? e);
  }
  setUI(S.closeOverlay);
}

async function openOpsPod() {
  const s = useUI.getState();
  if (s.overlay?.kind === "opspod") return;
  const pane = S.focusedPane(s);
  const key = selectedKey(pane);
  const [target, opsDefaults] = await Promise.all([
    key && pane.serverId ? bridge().opsPodTarget(pane.serverId, key).catch(() => ({ node: undefined })) : { node: undefined },
    bridge().opsPodDefaults().catch(() => undefined),
  ]);
  setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "opspod", pane: pane.id, node: target.node, opsDefaults }));
}

/**
 * The ops pod dialog's ⏎: Go prepares it (safety policy, the node exists),
 * then it's confirmed if the rule asks for it, else started. A refusal is
 * returned so the dialog stays open with it.
 */
export async function submitOpsPod(cluster: string, node: string, opts: OpsPodOptions): Promise<string | undefined> {
  const o = useUI.getState().overlay;
  if (o?.kind !== "opspod") return;
  let pending: Pending;
  try {
    // what would fail after the dialog closed (a PV, edited YAML) fails here, with the dialog still open
    await bridge().checkOpsPod(cluster, node, opts);
    pending = await bridge().prepareOpsPod(cluster, node);
  } catch (e) {
    return errorText(e);
  }
  if (useUI.getState().overlay !== o) return; // cancelled meanwhile
  setUI(S.closeOverlay);
  try {
    await proceed(o.pane, undefined, pending, "", undefined, opts);
  } catch (e) {
    flash(o.pane, errorText(e), true);
  }
}

/**
 * The debug dialog's ⏎. Go validates image, target and profile; a refusal
 * (no image, unknown container) is returned so the dialog can stay open with it.
 */
export async function submitDebug(opts: DebugOptions): Promise<string | undefined> {
  const o = useUI.getState().overlay;
  if (o?.kind !== "debug" || !o.pending || !o.key) return;
  if (!opts.image.trim()) return "an image is needed, e.g. busybox";
  setUI(S.closeOverlay);
  try {
    await proceed(o.pane, o.key, o.pending, "", opts);
  } catch (e) {
    flash(o.pane, errorText(e), true);
  }
}

/** ⏎ or a click in the container picker. */
export async function pickContainer(name: string | undefined) {
  const o = useUI.getState().overlay;
  const c = o?.containers?.find((x) => x.name === name);
  if (o?.kind !== "container" || !o.pending || !o.key || !c || c.disabled) return;
  setUI(S.closeOverlay);
  try {
    await proceed(o.pane, o.key, o.pending, c.name);
  } catch (e) {
    flash(o.pane, errorText(e), true);
  }
}

async function runConfirmed() {
  const o = useUI.getState().overlay;
  if (o?.kind !== "confirm" || !o.pending) return;
  setUI(S.closeOverlay);
  try {
    await execute(o.pane, o.pending, o.container, o.debug, o.ops, o.edit);
  } catch (e) {
    flash(o.pane, errorText(e), true);
  }
}

async function execute(paneId: string, p: Pending, container = "", debug?: DebugOptions, ops?: OpsPodOptions, edit?: S.EditState) {
  switch (p.action.kind) {
    case "edit": {
      if (!edit) return;
      try {
        await bridge().editApply(p.token, edit.session, edit.yaml);
      } catch (e) {
        // nothing typed is lost: back in the editor, with why
        return reopenEdit(paneId, { ...edit, preview: undefined, error: errorText(e) });
      }
      // written: the editor goes (back to the object view, or the table it was opened from)
      setUI((x) => (x.panes[paneId]?.object?.edit?.session === edit.session ? closeEditor(x, paneId) : x));
      return flash(paneId, `edited ${p.action.resource}/${p.action.name}`);
    }
    case "delete":
      await bridge().delete(p.token);
      return flash(paneId, `deleted ${p.action.resource}/${p.action.name}`);
    case "exec": {
      const r = await bridge().execStart(p.token, container, 80, 24);
      const term: S.Term = { session: r.session, pod: r.pod, container: r.container, context: r.context };
      return setUI((x) => S.openTerminal(x, term, paneId));
    }
    case "debug": {
      if (!debug) return;
      const r = await bridge().debugStart(p.token, debug, 80, 24);
      const term: S.Term = { session: r.session, pod: r.pod, container: r.container, context: r.context, debug: { image: r.image, target: r.target } };
      return setUI((x) => S.openTerminal(x, term, paneId));
    }
    case "opspod": {
      if (!ops) return;
      const r = await bridge().opsPodStart(p.token, ops, 80, 24);
      const term: S.Term = {
        session: r.session, pod: r.pod, container: "ops-pod", context: r.context,
        ops: { node: r.node, namespace: r.namespace, image: r.image, settings: r.settings },
      };
      return setUI((x) => S.openTerminal(x, term, paneId));
    }
  }
}

/** The row a pane's row commands act on: the table's selected one; in an object view, its object. */
function selectedKey(pane: S.PaneState): string | undefined {
  if (!pane.serverId || pane.term || pane.logs) return undefined;
  if (pane.object) return pane.object.key;
  const d = paneData.get(pane.serverId);
  return d.order[pane.selected - d.offset];
}

/** An object view has no row on screen to anchor a menu to (its table is hidden, or another pane's): below its header. */
function belowHeader(pane: S.PaneState): { x: number; y: number } | undefined {
  if (!pane.object) return undefined;
  const b = document.querySelector(`[data-pane="${pane.id}"] header`)?.getBoundingClientRect();
  return b && { x: b.left + 8, y: b.bottom };
}

/**
 * ⌘J, on a row (or from its object view): the jump menu. Opened from the
 * ⌘⏎ menu it takes that menu's place, at the same anchor.
 */
function openJump() {
  const s = useUI.getState();
  const o = s.overlay;
  const pane = S.focusedPane(s);
  const key = selectedKey(pane);
  if (!key) return;
  const at = o?.kind === "menu" ? o.at : belowHeader(pane);
  setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "jump", pane: pane.id, key, index: 0, rowIndex: pane.object ? undefined : pane.selected, at }));
}

/**
 * v, on a row (or from its object view): the pane jumps to the events about
 * it, as a jump menu entry would (⌘← goes back to the row). Go builds the
 * target (field selector on the involved object).
 */
async function openEvents() {
  const pane = S.focusedPane(useUI.getState());
  const key = selectedKey(pane);
  if (!pane.serverId || !key) return;
  try {
    const target = await bridge().eventsTarget(pane.serverId, key);
    setUI(S.closeOverlay);
    await jumpTo(pane.id, target, false, key);
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

/**
 * ⏎ / ⇧⏎ (or a click) on a jump menu entry: the pane shows the target, its
 * previous view pushed on the history (⌘← returns, ⌘→ redoes), or
 * the target opens in a split below. Entries without a target (a gone
 * owner) and the scan entry are handled by the menu itself.
 */
export async function runJump(index: number, inSplit: boolean) {
  const o = useUI.getState().overlay;
  if (o?.kind !== "jump") return;
  const item = useJump.getState().items[index];
  if (!item || !jumpable(item)) return;
  if (item.scan) return void useJump.getState().scan?.();
  const pane = useUI.getState().panes[o.pane];
  if (!pane || !item.target) return;
  setUI(S.closeOverlay);
  await jumpTo(pane.id, item.target, inSplit, o.key);
}

/**
 * Shows a jump target in a pane (pushing its current view, an object view
 * over the table included: ⌘← returns to it) or in a new split below it.
 * A split object view has no table of its own: its jumps go to a split.
 */
export async function jumpTo(paneId: string, target: JumpTarget, inSplit: boolean, fromKey?: string) {
  const pane = useUI.getState().panes[paneId];
  if (!pane) return;
  const spec = S.jumpSpec(pane.spec, target);
  if (inSplit || pane.object?.split) {
    // the new pane opens itself on mount (Pane's effect), like any split
    return setUI((x) => S.splitWith(S.focusPane(x, paneId), spec));
  }
  setUI((x) => S.updatePane(S.pushHistory(x, paneId, fromKey), paneId, ({ object: _, ...p }) => p));
  await applySpec(paneId, spec);
}

/**
 * ⌘O ⏎: the pane shows spec; a new source pushes its current view (and
 * selected row), as a jump does. An object view goes: the pane is a table
 * again (a split one, with a server pane of its own).
 */
export async function openSource(paneId: string, spec: S.PaneSpec) {
  const pane = useUI.getState().panes[paneId];
  if (!pane) return;
  if (pane.object && !pane.object.split) setUI((x) => S.pushHistory(x, paneId, pane.object!.key));
  else setUI((x) => S.openHistory(x, paneId, spec, selectedKey(pane)));
  setUI((x) => S.updatePane(x, paneId, ({ object: _, ...p }) => p));
  await applySpec(paneId, spec);
}

/**
 * ⌘← / ⌘→ in the table (or the header's ← / → buttons): the view before the
 * last jump or ⌘O, or forward again to the one just left; the row selected
 * there is selected again. steps: several at once, picked from the history list.
 */
export async function moveHistory(dir: "back" | "forward", paneId = S.focusedPane(useUI.getState()).id, steps = 1) {
  const pane = useUI.getState().panes[paneId];
  if (!pane || pane.term || pane.object?.split) return;
  if (S.unsaved(pane)) return flash(pane.id, "unsaved changes in the editor: esc to discard them first", true);
  const { state, entry } = S.moveHistory(useUI.getState(), pane.id, dir, selectedKey(pane), steps);
  if (!entry) return flash(pane.id, dir === "back" ? "nothing to go back to" : "nothing to go forward to");
  setUI(() => state);
  // into or out of an object view over the same table: that table is already there, as it was (row, scroll)
  if (S.sameSource(pane.spec, entry.spec) && JSON.stringify(pane.spec) === JSON.stringify(entry.spec) && (pane.object || entry.object)) {
    return setUI((x) => S.updatePane(x, pane.id, (p) => ({ ...p, reselect: undefined })));
  }
  await applySpec(pane.id, entry.spec, true);
}

/** Holding the ← / → button: that direction's history as a list below it, the nearest view first and highlighted. */
export function openHistoryList(paneId: string, dir: "back" | "forward", at: { x: number; y: number }) {
  const p = useUI.getState().panes[paneId];
  if (!(dir === "back" ? p?.back : p?.forward)?.length) return;
  setUI((x) => S.openOverlay(S.closeOverlay(S.focusPane(x, paneId)), { kind: "history", pane: paneId, dir, index: 0, at }));
}

/** ⏎ / click on an entry of the history list: goes there (index 0 is one step). */
export async function pickHistory(index: number) {
  const o = useUI.getState().overlay;
  if (o?.kind !== "history" || !o.dir) return;
  setUI(S.closeOverlay);
  await moveHistory(o.dir, o.pane, index + 1);
}

function moveInHistory(s: S.UIState, delta: number): S.UIState {
  const o = s.overlay;
  const n = (o?.dir === "back" ? s.panes[o.pane]?.back : o?.dir === "forward" ? s.panes[o.pane]?.forward : undefined)?.length ?? 0;
  if (!o || n === 0) return s;
  return { ...s, overlay: { ...o, index: Math.min(Math.max((o.index ?? 0) + delta, 0), n - 1) } };
}

/** Moves the jump menu highlight, skipping entries that go nowhere. */
function moveJump(s: S.UIState, delta: number): S.UIState {
  const i = S.wrapIndex(useJump.getState().items, s.overlay?.index ?? 0, delta, jumpable);
  return s.overlay && i !== undefined ? { ...s, overlay: { ...s.overlay, index: i } } : s;
}

/** Moves the menu highlight, skipping disabled entries. */
function moveMenu(s: S.UIState, delta: number): S.UIState {
  const i = S.wrapIndex(useMenu.getState().items, s.overlay?.index ?? 0, delta, (it) => !it.disabled);
  return s.overlay && i !== undefined ? { ...s, overlay: { ...s.overlay, index: i } } : s;
}

function moveContainer(s: S.UIState, delta: number): S.UIState {
  const o = s.overlay;
  if (!o?.containers) return s;
  const index = moveChoice(o.containers, o.index ?? 0, delta);
  return index === o.index ? s : { ...s, overlay: { ...o, index } };
}

function moveCell(s: S.UIState, delta: number): S.UIState {
  const o = s.overlay;
  if (!o?.cells) return s;
  const index = moveChoice(o.cells, o.index ?? 0, delta);
  return index === o.index ? s : { ...s, overlay: { ...o, index } };
}

function moveForward(s: S.UIState, delta: number): S.UIState {
  const n = usePortForwards.getState().list.length;
  if (!s.overlay || n === 0) return s;
  const index = Math.max(0, Math.min(n - 1, (s.overlay.index ?? 0) + delta));
  return { ...s, overlay: { ...s.overlay, index } };
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e);

/**
 * Applies a new spec to a pane: reuses the server pane if only stages changed.
 * keepReselect: moving through the history, the row to select again stays pending (see S.moveHistory).
 */
export async function applySpec(paneId: string, spec: S.PaneSpec, keepReselect = false) {
  const p = useUI.getState().panes[paneId];
  if (!p) return;
  // a borrowed server pane (a split object view's) is the table's: never changed from here
  const keep = !!p.serverId && !p.leased && S.sameSource(p.spec, spec);
  // a new source detaches the old server pane right away (the store closes it),
  // so nothing ever shows the old data under the new spec
  setUI((x) =>
    S.updatePane(x, paneId, (q) => ({
      ...q,
      spec,
      error: undefined,
      selected: 0,
      reselect: keepReselect ? q.reselect : undefined,
      serverId: keep ? q.serverId : undefined,
      leased: undefined,
      context: keep ? q.context : undefined,
      kind: keep ? q.kind : undefined,
      type: keep ? q.type : undefined,
      ambiguous: keep ? q.ambiguous : undefined,
      opening: !keep,
    })),
  );
  try {
    if (keep) {
      await bridge().update(p.serverId!, S.pipelineYAML(spec));
      return;
    }
    const res = await bridge().open(S.pipelineYAML(spec));
    if (useUI.getState().panes[paneId]?.spec !== spec) {
      bridge().close(res.pane).catch(() => {}); // superseded or pane closed meanwhile
      return;
    }
    // the type's default sort (events: latest first) becomes the pane's own, so the header shows it and a click cycles from it
    const sort = spec.sort ?? res.sort;
    setUI((x) => S.updatePane(x, paneId, (q) => ({ ...q, spec: sort === spec.sort ? q.spec : { ...q.spec, sort }, serverId: res.pane, context: res.context, kind: res.kind, type: res.type, ambiguous: res.ambiguous, opening: false })));
  } catch (e) {
    setUI((x) => S.updatePane(x, paneId, (q) => ({ ...q, error: String((e as Error).message ?? e), serverId: undefined, opening: false })));
  }
}

/** Record history on/off for a pane's source; the status line shows it once the next frame says so. */
export async function toggleRecording(paneId: string) {
  const pane = useUI.getState().panes[paneId];
  if (!pane?.serverId) return;
  const on = !paneData.get(pane.serverId).status?.recording;
  try {
    await bridge().setRecording(pane.serverId, on);
  } catch (e) {
    flash(paneId, `record history: ${(e as Error).message}`, true);
  }
}

type TravelMove = { enter: true } | { live: true } | { step: number } | { shift: number } | { start: true } | { to: string };

/**
 * One time-travel call per pane at a time (each rebuilds the table in Go);
 * moves made meanwhile wait, merged: steps add up (← ← is two changes back,
 * a held arrow is one call per answer), any other move replaces them.
 */
const traveling = new Map<string, TravelMove | null>();

function merge(a: TravelMove | null, b: TravelMove): TravelMove {
  if (a && "step" in a && "step" in b) return { step: a.step + b.step };
  return b;
}

/**
 * Moves a pane in time (Go rebuilds it as of the moment; frames follow).
 * Entering starts at the newest change and starts recording if needed.
 */
export async function travel(paneId: string, move: TravelMove) {
  const p = useUI.getState().panes[paneId];
  // a split object view's server pane is its table's: the table travels, not the object view
  const id = p && !p.leased && !p.object ? p.serverId : undefined;
  if (!id) return;
  if (traveling.has(id)) {
    traveling.set(id, merge(traveling.get(id) ?? null, move));
    return;
  }
  traveling.set(id, null);
  let next: TravelMove | null = move;
  while (next) {
    await travelOnce(paneId, id, next);
    next = traveling.get(id) ?? null;
    traveling.set(id, null);
  }
  traveling.delete(id);
}

async function travelOnce(paneId: string, id: string, move: TravelMove) {
  try {
    const b = bridge();
    const tl = useTimelines.getState().byPane[id];
    let next;
    if ("live" in move) next = await b.setTime(id, "");
    else if ("to" in move) next = await b.setTime(id, move.to);
    else if ("start" in move) next = tl ? await b.setTime(id, tl.horizon) : undefined;
    else if ("shift" in move) {
      const cur = tl ?? (await b.timeline(id));
      const to = shifted(cur, move.shift);
      next = await b.setTime(id, to ?? "");
    } else if ("step" in move) {
      if (move.step === 0) return;
      // past the newest change it stays there (Esc, End or t go back to live)
      next = (await b.step(id, move.step)).timeline;
    } else {
      // enter: recording on (if needed), then the newest change, or now if there is none
      const wasRecording = !!paneData.get(id).status?.recording;
      next = await b.setTime(id, new Date().toISOString());
      const r = await b.step(id, -1);
      if (r.moved) next = r.timeline;
      if (!wasRecording) flash(paneId, "recording history from now on: the timeline starts here", false);
    }
    setTimeline(id, next);
  } catch (e) {
    flash(paneId, `time-travel: ${(e as Error).message}`, true);
  }
}

/**
 * ⏎ in an object view: the field under the cursor decoded, in its place
 * (or in the object diff: the field decoded in both versions, diffed). ⏎ in
 * a decoded YAML decodes the field under its cursor, a level deeper.
 */
function openDecode(pane: S.PaneState) {
  const o = pane.object;
  if (!o || o.edit || o.view === "describe") return;
  const cur = cursorOf(viewSlot(pane.id, !!o.decode));
  if (cur.text === undefined) return;
  setUI((x) => S.decodeDeeper(x, pane.id, cur.line));
}

/** ⇧H in the YAML: how the field under the cursor went over time (needs recording). */
async function openFieldHistory() {
  const pane = S.focusedPane(useUI.getState());
  const o = pane.object;
  if (!o || o.view === "describe" || o.decode || o.edit || !pane.serverId) return;
  const cur = cursorOf(pane.id);
  if (cur.text === undefined) return;
  if (!paneData.get(pane.serverId).status?.recording) return flash(pane.id, "field history needs record history (⇧R in the table)", true);
  try {
    // the line is one of the YAML view (the object) or of the diff's right side (normalized)
    const fh = await bridge().fieldHistory(pane.serverId, o.key, o.diff ? (o.version ?? 0) : 0, cur.line, o.diff ? "norm" : "yaml");
    if (!fh.changes.length) return flash(pane.id, `no history of ${fh.path}`, true);
    setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "field", pane: pane.id, key: o.key, field: fh, index: fh.changes.length - 1 }));
  } catch (e) {
    flash(pane.id, `field history: ${(e as Error).message}`, true);
  }
}

function moveField(s: S.UIState, d: number): S.UIState {
  const o = s.overlay;
  const n = o?.field?.changes.length ?? 0;
  if (o?.kind !== "field" || !n) return s;
  return { ...s, overlay: { ...o, index: Math.max(0, Math.min(n - 1, (o.index ?? 0) + d)) } };
}

/**
 * ⏎ on a field's change: the table goes to that moment and shows it then
 * (the object view over it goes back to it; a split's table gets the focus).
 */
function pickField(paneId: string, at: string | undefined) {
  if (!at) return;
  setUI(S.closeOverlay);
  const p = useUI.getState().panes[paneId];
  const table = p?.object?.split ? p.object.from : paneId;
  const t = table ? useUI.getState().panes[table] : undefined;
  if (!t || t.serverId !== p?.serverId) return flash(paneId, "the table this object came from is gone", true);
  setUI((x) => (p!.object?.split ? S.focusPane(x, t.id) : S.leaveObject(x, paneId)));
  void travel(t.id, { to: at });
}
