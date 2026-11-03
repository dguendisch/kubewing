import type { CommandId } from "./keys/keymap";
import { bridge, paneData, setUI, useColumns, usePortForwards, useUI } from "./store/store";
import type { ActionKind, Batch, ClusterEntry, ColumnSpec, MarkOp, MetricsPlace, DebugOptions, JumpTarget, Launch, LogsOptions, OpsPodOptions, Pending } from "./transport/types";
import { useMenu } from "./actions/registry";
import { jumpItems, jumpable, useJump, type JumpState } from "./actions/jump";
import { celFromLeaf, yamlLeaf } from "./complete/cel";
import { cursorOf, diffNavOf, useDiffRange, viewSlot, type Place } from "./editor/Viewer";
import { sameLine } from "./editor/carry";
import * as S from "./store/state";
import { setTimeline, shifted, useTimelines } from "./store/travel";
import { containerChoices, initialChoice, moveChoice, needsPicker } from "./components/containers";
import { initialColumns, metricsOn, moveShown, toConfig, toggleMetrics, type MetricGroup } from "./components/columnsForm";
import { cellChoices, initialCell, wholeRow } from "./grid/cells";
import { nowOf, rowAt } from "./grid/rowcache";
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
    case "pane.resizeLeft":
      return resizePane("left");
    case "pane.resizeRight":
      return resizePane("right");
    case "pane.resizeUp":
      return resizePane("up");
    case "pane.resizeDown":
      return resizePane("down");
    case "pane.toggleMaximize":
      return setUI(S.toggleMaximize);
    case "pane.rename":
      return setUI((x) => S.renamePane(x));
    case "tab.rename":
      return setUI((x) => S.renameTab(x));
    case "tab.new":
      return setUI(S.newTab);
    case "tab.close":
      return setUI((x) => S.requestCloseTab(x));
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
    case "mark.toggle":
      return void markToggle(pane);
    case "mark.down":
    case "mark.up":
    case "mark.pageDown":
    case "mark.pageUp":
    case "mark.first":
    case "mark.last": {
      const to = { "mark.down": 1, "mark.up": -1, "mark.pageDown": page, "mark.pageUp": -page, "mark.first": "first", "mark.last": "last" } as const;
      return void markExtend(pane, to[cmd], total);
    }
    case "mark.all":
      return void mark(pane, { op: "all" });
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
      return void hasMarks(pane).then((many) => (many ? copyMarkedNames(pane) : copyName(pane)));
    case "table.copy":
      return void copySelection(pane);
    case "table.clearSelection":
      // the cell's text selection first, then the marks
      if (!pane.serverId) return;
      if (useTextSel.getState()[pane.serverId]) return setTextSel(pane.serverId, undefined);
      if (markedCount(pane)) return void mark(pane, { op: "clear" });
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
    case "menu.runTab": {
      // a jump menu's cluster entry in a new tab; other menu entries have no tab of their own
      const o = s.overlay;
      if (o?.kind === "jump" && useJump.getState().items[o.index ?? 0]?.cluster) return void runJump(o.index ?? 0, "tab");
      return;
    }
    case "menu.runSplit": {
      const o = s.overlay;
      if (o?.kind === "jump") return void runJump(o.index ?? 0, "pane");
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
      if (o?.kind === "jump") return void runJump(o.index ?? 0, "here");
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
    case "object.label":
      return void prepareAction("label");
    case "object.annotate":
      return void prepareAction("annotate");
    case "object.scale":
      return void prepareAction("scale");
    case "object.restart":
      return void prepareAction("restart");
    case "terminal.splitDown":
    case "terminal.splitRight":
      return void openLocalTerminal(cmd === "terminal.splitDown" ? "column" : "row");
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
    case "view.toggleMetrics":
      return void toggleMetricColumns(pane.id, "usage");
    case "view.toggleAllocation":
      return void toggleMetricColumns(pane.id, "alloc");
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
    case "cluster.open":
      return setUI((x) => (x.overlay?.kind === "clusters" ? S.closeOverlay(x) : S.openOverlay(S.closeOverlay(x), { kind: "clusters", pane: pane.id })));
    case "cluster.otherPlane":
      // of the dialogs only ⌘O, over the pane it opens for (a cluster just opened lists nothing yet)
      if (s.focus === "dialog" && s.overlay?.kind !== "open") return;
      return void switchPlane(s.overlay?.kind === "open" ? (s.panes[s.overlay.pane] ?? pane) : pane);
    case "config.reload":
      return void bridge().reloadConfig().catch(() => {}); // applied via the kw:config event
    case "source.reconnect":
      return void reconnect(pane.id);
    case "source.refresh":
      return void refresh(pane.id);
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

/** ⌘⌃arrows: the step and the smallest pane are pixels, so the active tab's dock is measured. */
function resizePane(dir: "left" | "right" | "up" | "down") {
  const s = useUI.getState();
  const r = document.querySelector(`[data-dock="${S.activeTab(s).id}"]`)?.getBoundingClientRect();
  if (r) setUI((x) => S.resizePane(x, dir, { width: r.width, height: r.height }));
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
  const cells = cellChoices(row, d.columns, nowOf(d));
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
  if (batchKinds.has(kind) && (await hasMarks(pane)) && (await prepareMarked(pane, kind))) return;
  // in an object view: its object (the native menu, ⌘⌫ there)
  const key = selectedKey(pane);
  if (!pane.serverId || !key) return;
  try {
    const pending = await bridge().prepare(kind, pane.serverId, key);
    if (kind === "debug") return setUI((x) => S.openOverlay(x, { kind: "debug", pane: pane.id, key, pending }));
    if (kind === "label" || kind === "annotate" || kind === "scale") return setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "meta", pane: pane.id, key, pending }));
    if (kind === "exec") {
      const containers = containerChoices((await bridge().rowInfo(pane.serverId, key)).containerInfo ?? []);
      if (needsPicker(containers)) {
        return setUI((x) => S.openOverlay(x, { kind: "container", pane: pane.id, key, pending, containers, index: initialChoice(containers) }));
      }
    }
    await proceed(pane.id, key, pending, {});
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

/** Actions that act on the marked rows, when there are any (else on the cursor row). */
const batchKinds = new Set<ActionKind>(["delete", "label", "annotate", "scale", "restart", "debug"]);

/** At most this many pods get a debug container at once (a pane each, in a tab of their own). */
export const maxDebugPods = 8;

/**
 * An action on the marked rows: Go prepares it for each (one decision, a
 * token each; rows it doesn't apply to are skipped and said so), then its
 * dialog or confirmation, as for one row.
 */
async function prepareMarked(pane: S.PaneState, kind: ActionKind): Promise<boolean> {
  let batch: Batch;
  try {
    batch = await bridge().prepareMarked(kind, pane.serverId!);
  } catch (e) {
    // the marks went meanwhile (a filter hid them): the cursor row's action instead
    if (errorText(e) === "no rows marked") return false;
    flash(pane.id, errorText(e), true);
    return true;
  }
  try {
    if (kind === "debug" && batch.rows.length > maxDebugPods) flash(pane.id, `debug: ${batch.rows.length} pods marked, at most ${maxDebugPods} at once`, true);
    else if (kind === "debug") setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "debug", pane: pane.id, batch }));
    else if (kind === "label" || kind === "annotate" || kind === "scale") setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "meta", pane: pane.id, batch }));
    else await proceedBatch(pane.id, batch, {});
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
  return true;
}

/** A prepared batch, its options picked: confirm if the rule asks for it, else run. */
async function proceedBatch(paneId: string, batch: Batch, input: ActionInput) {
  if (batch.needsConfirm) setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "confirm", pane: paneId, batch, ...input }));
  else await executeBatch(paneId, batch, input);
}

/** Runs fn on every item, at most limit at once; the outcomes in order. */
async function pooled<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!, i) };
      } catch (e) {
        out[i] = { status: "rejected", reason: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const pastTense: Partial<Record<ActionKind, string>> = { delete: "deleted", label: "labeled", annotate: "annotated", scale: "scaled", restart: "restarted", debug: "started debug containers in" };

/**
 * Executes a batch, each row with its own token (≤ 8 at once). The status
 * line says how many went through, and the first failures by name; the
 * marks stay (a failed row can be retried), except after a delete.
 */
async function executeBatch(paneId: string, b: Batch, { debug, meta, scale }: ActionInput) {
  const what = b.rows.length === 1 ? b.pending[0]!.action.resource : b.summary.split(" ")[2] ?? "objects";
  if (b.kind === "debug") {
    if (!debug) return;
    const results = await pooled(b.pending, 8, (p) => bridge().debugStart(p.token, debug, 80, 24));
    const terms: S.Term[] = [];
    results.forEach((r) => {
      if (r.status === "fulfilled") terms.push({ session: r.value.session, pod: r.value.pod, container: r.value.container, context: r.value.context, debug: { image: r.value.image, target: r.value.target } });
    });
    if (terms.length) setUI((x) => S.openTerminalTab(x, terms, `debug ×${terms.length}`, paneId));
    return report(paneId, b, results, `${pastTense.debug} ${terms.length} pods`);
  }
  const run = (p: Pending) => {
    switch (b.kind) {
      case "delete":
        return bridge().delete(p.token);
      case "label":
        return bridge().label(p.token, meta!.changes);
      case "annotate":
        return bridge().annotate(p.token, meta!.changes);
      case "scale":
        return bridge().scale(p.token, scale!.replicas);
      case "restart":
        return bridge().restart(p.token);
    }
    return Promise.reject(new Error(`${b.kind} acts on one row only`));
  };
  if ((b.kind === "label" || b.kind === "annotate") && !meta) return;
  if (b.kind === "scale" && !scale) return;
  const results = await pooled(b.pending, 8, run);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  if (b.kind === "delete" && ok === results.length) {
    const p = useUI.getState().panes[paneId];
    if (p) void mark(p, { op: "clear" });
  }
  report(paneId, b, results, `${pastTense[b.kind]} ${ok === results.length ? "" : `${ok} of `}${results.length} ${what}${b.kind === "scale" ? ` to ${scale!.replicas}` : ""}`);
}

/** The outcome of a batch in the status line: what went through, then the first failures with their names. */
function report(paneId: string, b: Batch, results: PromiseSettledResult<unknown>[], done: string) {
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${b.pending[i]!.action.name}: ${errorText(r.reason)}`] : []));
  if (!failed.length) return flash(paneId, done);
  const ok = results.length - failed.length;
  flash(paneId, `${ok ? done : `${b.kind} failed`} — ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? `; and ${failed.length - 3} more` : ""}`, true);
}

/** Copy name with marked rows: their names, space-separated (as kubectl get takes them). */
async function copyMarkedNames(pane: S.PaneState) {
  try {
    const rows = await bridge().marked(pane.serverId!);
    if (!rows.length) return copyName(pane);
    await bridge().copyText(rows.map((r) => r.name).join(" "));
    flash(pane.id, `copied ${rows.length} names`);
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

/** What a prepared action runs with, picked in its dialog (the confirmation shows it). */
type ActionInput = Pick<S.Overlay, "container" | "debug" | "ops" | "edit" | "split" | "meta" | "scale">;

/** A prepared action, its container (exec) or options (debug, ops pod, edit, label, scale …) picked: confirm if the rule asks for it, else run. */
async function proceed(paneId: string, key: string | undefined, pending: Pending, input: ActionInput) {
  if (pending.needsConfirm) setUI((x) => S.openOverlay(x, { kind: "confirm", pane: paneId, key, pending, ...input }));
  else await execute(paneId, pending, input);
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
    const edit: S.EditState = { session: es.session, key, title: `${info.kind} ${info.name}`, opened: es.yaml, yaml: es.yaml, at: carriedPlace(now, es.yaml) };
    // ⇧E: a split of its own, opened in the editor (closing the editor closes the split, as e's goes back to the table)
    if (inSplit) return setUI((x) => S.withEdit(S.openObjectSplit(S.closeOverlay(x), { key, view: "yaml", title: info.name, viaEdit: true }, pane.id), edit));
    if (before) return setUI((x) => S.setObject(x, pane.id, (o) => ({ ...o, edit, title: o.title ?? info.name })));
    setUI((x) => S.openObject(S.closeOverlay(x), pane.id, { key, view: "yaml", title: info.name, edit, viaEdit: true }));
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

/** The object view's cursor (its YAML or diff), on the same line of the YAML opened for editing; none from the table, a decoded value or describe. */
function carriedPlace(pane: S.PaneState, yaml: string): Place | undefined {
  const o = pane.object;
  if (!o || o.decode || o.view === "describe") return undefined;
  const cur = cursorOf(pane.id);
  const at = cur.place?.();
  if (!cur.text || !at) return undefined;
  const line = sameLine(cur.text, at.line, yaml);
  return { ...at, line, col: line === at.line && cur.text === yaml ? at.col : 0 };
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
  await proceed(paneId, e.key, pending, { edit: e });
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

/** The saved place of a group of metric columns (TypeView.metrics / .allocation). */
export const placeKey = { usage: "metrics", alloc: "allocation" } as const;

const groupText = {
  usage: { name: "metrics", on: "metrics on: polled every 15s", none: "metrics (kubectl top) are for pods and nodes" },
  alloc: { name: "requests/limits", on: "requests/limits on: summed from the pods on each node", none: "requests/limits of their pods are for nodes" },
};

/**
 * m: the usage columns (kubectl top) on or off for the pane's type; ⇧M the
 * same for a node's requests/limits (kubectl describe node), which list all
 * the context's pods first. As the column dialog's switches: every pane of
 * the type follows.
 */
export async function toggleMetricColumns(paneId: string, group: MetricGroup) {
  const p = useUI.getState().panes[paneId];
  if (!p?.serverId || !p.type) return;
  const text = groupText[group];
  try {
    const choices = await bridge().columnChoices(p.serverId);
    const rows = initialColumns(choices.options);
    if (!rows.some((r) => r.metric === group)) return flash(paneId, text.none, true);
    const on = !metricsOn(rows, group);
    const t = toggleMetrics(rows, group, useColumns.getState().types[p.type]?.[placeKey[group]]);
    // on: the place is used, nothing to keep (off again saves the one then)
    await bridge().setTypeMetrics(p.type, group, toConfig(t.rows, choices.defaults), t.place ?? null);
    flash(paneId, on ? text.on : `${text.name} off`);
  } catch (e) {
    flash(paneId, `${text.name}: ${errorText(e)}`, true);
  }
}

/**
 * The column dialog's ⏎: Go validates and saves; the error, if any, is
 * shown in the dialog. places: the metric switches used, with where their
 * columns were when turned off (null: turned on, used up).
 */
export async function submitColumns(type: string, columns: ColumnSpec[] | null, places: Partial<Record<MetricGroup, MetricsPlace | null>> = {}): Promise<string | undefined> {
  try {
    const groups = Object.keys(places) as MetricGroup[];
    if (groups.length === 0) await bridge().setTypeColumns(type, columns);
    // one group's place per call; the columns are the same each time
    for (const g of groups) await bridge().setTypeMetrics(type, g, columns, places[g]!);
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
 * ⌃T / ⌃⇧T: a local shell on the focused pane's context and namespace (its
 * kubeconfig is the shell's own), in a split below / to the right. Go checks
 * the safety rule (a read-only context refuses it), which may ask first.
 */
async function openLocalTerminal(split: "row" | "column") {
  const pane = S.focusedPane(useUI.getState());
  try {
    const pending = await bridge().prepareTerminal(pane.spec.context, pane.spec.namespace);
    if (pending.needsConfirm) return setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "confirm", pane: pane.id, pending, split }));
    await execute(pane.id, pending, { split });
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
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
    await proceed(o.pane, undefined, pending, { ops: opts });
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
  if (o?.kind !== "debug" || !(o.batch || (o.pending && o.key))) return;
  if (!opts.image.trim()) return "an image is needed, e.g. busybox";
  setUI(S.closeOverlay);
  try {
    if (o.batch) await proceedBatch(o.pane, o.batch, { debug: opts });
    else await proceed(o.pane, o.key, o.pending!, { debug: opts });
  } catch (e) {
    flash(o.pane, errorText(e), true);
  }
}

/**
 * The label / annotate / scale dialog's ⏎ (checked there). The changes go
 * to the confirmation, if the rule asks for one, else straight to Go, which
 * validates keys and values; a refusal is returned so the dialog stays open
 * with it, the text kept.
 */
export async function submitMeta(input: Pick<ActionInput, "meta" | "scale">): Promise<string | undefined> {
  const o = useUI.getState().overlay;
  if (o?.kind === "meta" && o.batch) {
    // the confirmation, or straight on: failures are reported per row in the status line
    const b = o.batch;
    if (!b.needsConfirm) setUI(S.closeOverlay);
    await proceedBatch(o.pane, b, input);
    return;
  }
  if (o?.kind !== "meta" || !o.pending || !o.key) return;
  if (o.pending.needsConfirm) {
    setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "confirm", pane: o.pane, key: o.key, pending: o.pending, ...input }));
    return;
  }
  try {
    await execute(o.pane, o.pending, input);
  } catch (e) {
    // the token is spent: a fresh one for the next try
    try {
      const pending = await bridge().prepare(o.pending.action.kind, useUI.getState().panes[o.pane]?.serverId ?? "", o.key);
      setUI((x) => (x.overlay === o ? { ...x, overlay: { ...o, pending } } : x));
    } catch {
      setUI((x) => (x.overlay === o ? S.closeOverlay(x) : x));
    }
    return errorText(e);
  }
  setUI((x) => (x.overlay === o ? S.closeOverlay(x) : x));
}

/** ⏎ or a click in the container picker. */
export async function pickContainer(name: string | undefined) {
  const o = useUI.getState().overlay;
  const c = o?.containers?.find((x) => x.name === name);
  if (o?.kind !== "container" || !o.pending || !o.key || !c || c.disabled) return;
  setUI(S.closeOverlay);
  try {
    await proceed(o.pane, o.key, o.pending, { container: c.name });
  } catch (e) {
    flash(o.pane, errorText(e), true);
  }
}

async function runConfirmed() {
  const o = useUI.getState().overlay;
  if (o?.kind !== "confirm" || !(o.pending || o.batch)) return;
  setUI(S.closeOverlay);
  try {
    if (o.batch) await executeBatch(o.pane, o.batch, o);
    else await execute(o.pane, o.pending!, o);
  } catch (e) {
    flash(o.pane, errorText(e), true);
  }
}

async function execute(paneId: string, p: Pending, { container = "", debug, ops, edit, split = "column", meta, scale }: ActionInput) {
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
    case "label":
    case "annotate":
      if (!meta) return;
      await (p.action.kind === "label" ? bridge().label(p.token, meta.changes) : bridge().annotate(p.token, meta.changes));
      return flash(paneId, `${p.action.kind === "label" ? "labeled" : "annotated"} ${p.action.resource}/${p.action.name}`);
    case "scale":
      if (!scale) return;
      await bridge().scale(p.token, scale.replicas);
      return flash(paneId, `scaled ${p.action.resource}/${p.action.name} to ${scale.replicas}`);
    case "restart":
      await bridge().restart(p.token);
      return flash(paneId, `restarted ${p.action.resource}/${p.action.name}`);
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
    case "terminal": {
      const r = await bridge().terminalStart(p.token, 80, 24);
      const term: S.Term = { session: r.session, pod: "", container: "", context: r.context, local: { namespace: r.namespace } };
      return setUI((x) => S.openTerminal(x, term, paneId, split));
    }
  }
}

/**
 * Mark calls per server pane, in order, and the count the last one
 * returned: an action right after a mark (⇧↓ then ⌘⌫) waits for it rather
 * than for the frame that shows it. The count holds until the next frame,
 * which has it (and later prunes: a filter hiding a marked row).
 */
const marking = new Map<string, { done: Promise<void>; count?: number }>();

/** How many rows of a pane's table are marked, as far as known now (the last mark call, else the status); none in an object view. */
function markedCount(pane: S.PaneState): number {
  if (!pane.serverId || pane.object || pane.term || pane.logs) return 0;
  return marking.get(pane.serverId)?.count ?? paneData.get(pane.serverId).status.marked ?? 0;
}

/** Whether rows are marked, once the mark calls on their way are through. */
async function hasMarks(pane: S.PaneState): Promise<boolean> {
  if (pane.serverId) await marking.get(pane.serverId)?.done;
  return markedCount(pane) > 0;
}

function mark(pane: S.PaneState, op: MarkOp): Promise<void> {
  const id = pane.serverId;
  if (!id || pane.object) return Promise.resolve();
  if (op.op === "clear" || op.op === "all") setUI((x) => S.updatePane(x, pane.id, (p) => ({ ...p, markAnchor: undefined })));
  const m = marking.get(id) ?? { done: Promise.resolve() };
  const done = m.done.then(async () => {
    try {
      m.count = await bridge().mark(id, op);
      const off = paneData.subscribe(id, () => {
        off();
        if (marking.get(id)?.done === done) m.count = undefined;
      });
    } catch (e) {
      m.count = undefined; // the frames tell
      flash(pane.id, errorText(e), true);
    }
  });
  m.done = done;
  marking.set(id, m);
  return done;
}

/** Space, ⌘-click: the cursor row in or out of the marks; it becomes the anchor of the next range. */
export function markToggle(pane: S.PaneState, key = selectedKey(pane)) {
  if (!key || pane.object) return;
  setUI((x) => S.updatePane(x, pane.id, (p) => ({ ...p, markAnchor: key })));
  return mark(pane, { op: "toggle", key });
}

/**
 * ⇧↓ / ⇧↑ …: the cursor moves and the rows from the anchor to it are marked
 * (moving back unmarks again); ⇧-click: to the row clicked (an index). The
 * first one without an anchor starts at the cursor row.
 */
export function markExtend(pane: S.PaneState, to: number | "first" | "last" | { index: number }, total: number) {
  const from = pane.markAnchor ?? selectedKey(pane);
  if (!from || pane.object || !total) return;
  const index = typeof to === "object" ? to.index : to === "first" ? 0 : to === "last" ? total - 1 : pane.selected + to;
  const target = Math.max(0, Math.min(total - 1, index));
  setUI((x) => S.updatePane(x, pane.id, (p) => ({ ...p, selected: target, markAnchor: from })));
  return mark(pane, { op: "range", from, to: target });
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
  // the object view's header: the table's, hidden under it, has an empty box at the window's top left
  const b = [...document.querySelectorAll(`[data-pane="${pane.id}"] header`)].map((h) => h.getBoundingClientRect()).find((r) => r.height > 0);
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
  const yaml = fieldAtCursor(pane);
  // from an object's YAML: below the cursor's line (scrolled out of view: below the header)
  const at = o?.kind === "menu" ? o.at : ((yaml && cursorOf(yamlSlot(pane)).at?.()) ?? belowHeader(pane));
  setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "jump", pane: pane.id, key, index: 0, rowIndex: pane.object ? undefined : pane.selected, at, yaml }));
}

/**
 * The YAML at an object view's cursor (the view, the diff's right side, or
 * the editor's text as typed), for the jump menu's field section. Not
 * describe or a decoded value: no object fields there.
 */
function fieldAtCursor(pane: S.PaneState): { text: string; line: number } | undefined {
  const o = pane.object;
  if (!o || o.view === "describe" || o.decode || (o.edit && o.edit.preview)) return undefined;
  const cur = cursorOf(yamlSlot(pane));
  return cur.text === undefined ? undefined : { text: cur.text, line: cur.line };
}

/** The cursor slot of a pane's object YAML: the editor's while editing, else the viewer's. */
const yamlSlot = (pane: S.PaneState) => (pane.object?.edit ? `${pane.id}/edit` : pane.id);

/**
 * ⌘-click on a marked reference in an object's YAML: straight to the
 * object it names, as the field section's entry would (⇧: in a split; from
 * the editor always, so the edit stays).
 */
export async function jumpToField(paneId: string, text: string, line: number, inSplit: boolean) {
  const pane = useUI.getState().panes[paneId];
  if (!pane?.serverId || !pane.object) return;
  try {
    const rels = await bridge().fieldRelations(pane.serverId, text, line);
    const r = rels[0];
    if (!r) return flash(paneId, "no reference here", true);
    if (!r.target) return flash(paneId, `${r.label}: ${r.gone ?? "nowhere to go"}`, true);
    await jumpTo(paneId, r.target, inSplit, pane.object.key);
  } catch (e) {
    flash(paneId, errorText(e), true);
  }
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
export async function runJump(index: number, where: S.ClusterTarget) {
  const o = useUI.getState().overlay;
  if (o?.kind !== "jump") return;
  const item = useJump.getState().items[index];
  if (!item || !jumpable(item)) return;
  if (item.scan) return void useJump.getState().scan?.();
  const pane = useUI.getState().panes[o.pane];
  if (!pane) return;
  if (item.cluster) return void jumpToCluster(pane.id, item.id, item.cluster, where);
  if (!item.target) return;
  setUI(S.closeOverlay);
  await jumpTo(pane.id, item.target, where === "pane", o.key);
}

/**
 * ⌘J on a Gardener row: its shoot, control plane or seed, resolved as a ⌘P
 * pick (the garden may ask to log in: the menu says resolving… meanwhile,
 * errors stay on the entry) and opened as one: here (⌘← goes back), in a
 * split below or a new tab, listing nothing yet with ⌘O over it.
 */
async function jumpToCluster(paneId: string, id: string, entry: ClusterEntry, where: S.ClusterTarget) {
  const st = useJump.getState();
  if (st.resolving || !st.rel) return;
  const rel = st.rel;
  const update = (patch: Pick<JumpState, "resolving" | "clusterError">) => {
    const cur = { ...useJump.getState(), ...patch };
    useJump.setState({ ...patch, items: jumpItems(rel, cur) });
  };
  update({ resolving: id, clusterError: undefined });
  const still = () => useJump.getState().rel === rel && useUI.getState().overlay?.kind === "jump";
  try {
    const o = await bridge().openCluster(entry);
    if (!still()) return; // closed or moved on meanwhile
    // a jump knows the shoot's project: several choices can't happen, but say so if they do
    if (o.choices?.length) return update({ resolving: undefined, clusterError: { id, message: `${entry.shoot} exists in several projects: pick it in ⌘P` } });
    update({ resolving: undefined });
    setUI(S.closeOverlay);
    await openCluster(paneId, o.cluster, o.namespace ?? "", where);
  } catch (e) {
    if (still()) update({ resolving: undefined, clusterError: { id, message: String((e as Error)?.message ?? e) } });
  }
}

/**
 * Shows a jump target in a pane (pushing its current view, an object view
 * over the table included: ⌘← returns to it) or in a new split below it.
 * A split object view has no table of its own: its jumps go to a split.
 * From the editor always a split, to its right: the edit stays beside it.
 */
export async function jumpTo(paneId: string, target: JumpTarget, inSplit: boolean, fromKey?: string) {
  const pane = useUI.getState().panes[paneId];
  if (!pane) return;
  const spec = S.jumpSpec(pane.spec, target);
  const editing = !!pane.object?.edit;
  if (inSplit || editing || pane.object?.split) {
    // the new pane opens itself on mount (Pane's effect), like any split
    return setUI((x) => S.splitWith(S.focusPane(x, paneId), spec, editing ? "row" : "column"));
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
 * ⌘P ⏎: a cluster opened (Go resolved it: a kubeconfig's context, a
 * Gardener target's kubeconfig) where the dialog says: in a new tab, in a
 * new pane below the pane (⌘D) or in the pane, as a ⌘O context switch is.
 * It lists nothing yet: ⌘O opens over it, to pick what.
 */
export async function openCluster(paneId: string, cluster: string, namespace: string, where: S.ClusterTarget) {
  const spec = S.clusterSpec(cluster, namespace);
  const pane = useUI.getState().panes[paneId];
  if (where === "here" && pane && S.unsaved(pane)) return flash(pane.id, "unsaved changes in the editor: esc to discard them first", true);
  // a shell or log tail isn't a source to switch: a new tab keeps it
  if (where === "tab" || !pane || (where === "here" && (pane.term || pane.logs))) setUI((x) => S.launchTab(x, cluster, namespace, spec));
  else if (where === "pane") setUI((x) => S.splitWith(S.focusPane(x, paneId), spec));
  else await openSource(paneId, spec);
  setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "open", pane: S.focusedPane(x).id }));
}

/**
 * ⌘⇧P: the focused pane from a shoot to its control plane or back (Go
 * knows which target the pane's cluster is, once ⌘P or ⌘J resolved it). The
 * pane stays as it is (the resource, its view) on the other cluster; ⌘O open
 * over it (it lists nothing yet) is open over the other plane then.
 */
async function switchPlane(pane: S.PaneState) {
  if (pane.term || pane.logs) return flash(pane.id, "⌘⇧P switches a table pane between shoot and control plane", true);
  if (S.unsaved(pane)) return flash(pane.id, "unsaved changes in the editor: esc to discard them first", true);
  flash(pane.id, "resolving the other plane… (the garden may ask to log in)");
  try {
    const o = await bridge().otherPlane(pane.spec.context, pane.spec.namespace);
    const p = useUI.getState().panes[pane.id];
    if (!p) return;
    const picking = useUI.getState().overlay?.kind === "open";
    const spec = { ...S.openSpec(p.spec), context: o.cluster, namespace: o.namespace ?? "" };
    if (picking) setUI(S.closeOverlay);
    await openSource(p.id, spec);
    if (picking) setUI((x) => S.openOverlay(S.focusPane(x, p.id), { kind: "open", pane: p.id }));
  } catch (e) {
    flash(pane.id, String((e as Error)?.message ?? e), true);
  }
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
  // nothing to list yet (⌘P's new pane): the pane only holds the cluster, for ⌘O
  if (S.emptySpec(spec)) return setUI((x) => S.updatePane(x, paneId, ({ object: _, ...q }) => ({ ...q, spec, error: undefined, selected: 0, serverId: undefined, leased: undefined, context: S.splitCluster(spec.context).context || undefined, kind: undefined, type: undefined, opening: false })));
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

/**
 * ⌘R (or a click on the status line's "listed …"): a listing (everything in a
 * namespace) lists again. It isn't watched, so this is how it moves on; the new
 * listing marks what was added, removed and changed since. Live panes say so.
 */
export async function refresh(paneId: string) {
  const pane = useUI.getState().panes[paneId];
  if (!pane?.serverId || pane.term || pane.logs) return;
  if (!S.isAll(pane.spec.resource)) return flash(pane.id, "⌘R lists a listing again (everything in a namespace: resource all); this pane is live");
  try {
    await bridge().refresh(pane.serverId);
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

/**
 * A fresh connection to the pane's context (⌘⇧R, a click on the status line's
 * connection state): Go restarts every watch on it; panes on it whose open
 * failed (the network was down then) open again.
 */
export async function reconnect(paneId: string) {
  const pane = useUI.getState().panes[paneId];
  if (!pane) return;
  // a shell's or log pane's spec is the table's it came from: the same context
  const context = pane.spec.context;
  try {
    const n = await bridge().reconnect(context);
    const failed = S.failedPanes(useUI.getState(), context);
    for (const id of failed) void applySpec(id, useUI.getState().panes[id]!.spec);
    const what = n + failed.length === 1 ? "1 view" : `${n + failed.length} views`;
    flash(paneId, `reconnected ${S.clusterLabel(context)}: ${what} reloading`);
  } catch (e) {
    flash(paneId, errorText(e), true);
  }
}

/** Record changes on/off for a pane's source; the status line shows it once the next frame says so. */
export async function toggleRecording(paneId: string) {
  const pane = useUI.getState().panes[paneId];
  if (!pane?.serverId) return;
  const on = !paneData.get(pane.serverId).status?.recording;
  try {
    await bridge().setRecording(pane.serverId, on);
  } catch (e) {
    flash(paneId, `record changes: ${(e as Error).message}`, true);
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
  if (!paneData.get(pane.serverId).status?.recording) return flash(pane.id, "field history needs record changes (⇧R in the table)", true);
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
