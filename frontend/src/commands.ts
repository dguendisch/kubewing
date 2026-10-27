import type { CommandId } from "./keys/keymap";
import { bridge, paneData, setUI, useColumns, usePortForwards, useUI } from "./store/store";
import type { ActionKind, ColumnSpec, DebugOptions, JumpTarget, Launch, OpsPodOptions, Pending } from "./transport/types";
import { useMenu } from "./actions/registry";
import { jumpable, useJump } from "./actions/jump";
import { paneIds } from "./store/layout";
import { celFromLeaf, yamlLeaf } from "./complete/cel";
import { cursor, useDiffNav, useDiffRange } from "./editor/Viewer";
import * as S from "./store/state";
import { setTimeline, shifted, useTimelines } from "./store/travel";
import { containerChoices, initialChoice, moveChoice, needsPicker } from "./components/containers";
import { moveShown } from "./components/columnsForm";
import { cellChoices, initialCell, wholeRow } from "./grid/cells";
import { rowAt } from "./grid/rowcache";
import { selectedText, setTextSel, useTextSel } from "./grid/textsel";

/**
 * The single command dispatcher. Keyboard shortcuts, native menu
 * accelerators and UI buttons all end up here.
 */
export function dispatch(cmd: CommandId) {
  if (cmd.startsWith("tab.goto")) return setUI((x) => S.gotoTab(x, Number(cmd.slice(8))));
  const s = useUI.getState();
  const pane = S.focusedPane(s);
  const total = pane.serverId ? paneData.get(pane.serverId).total : 0;
  const page = 20;
  switch (cmd) {
    case "pane.splitRight":
      return setUI((x) => S.splitPane(x, "row"));
    case "pane.splitDown":
      return setUI((x) => S.splitPane(x, "column"));
    case "pane.close":
      return setUI((x) => S.closePane(x));
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
      // a tab with splits is work: losing it to a stray ⌘W would be expensive
      const tab = S.activeTab(s);
      if (paneIds(tab.layout).length < 2) return setUI((x) => S.closeTab(x));
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
    case "detail.open": {
      const key = selectedKey(pane);
      if (!key) return;
      return setUI((x) => S.openOverlay(x, { kind: "detail", pane: pane.id, key, view: "yaml" }));
    }
    case "object.diff": {
      const key = selectedKey(pane);
      if (!key) return;
      return setUI((x) => S.openOverlay(x, { kind: "detail", pane: pane.id, key, view: "yaml", diff: true }));
    }
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
      return setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "menu", pane: pane.id, key, index: 0, rowIndex: pane.selected }));
    }
    case "object.jump":
      return openJump();
    case "object.events":
      return void openEvents();
    case "menu.runSplit":
      if (s.overlay?.kind === "jump") return void runJump(s.overlay.index ?? 0, true);
      return;
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
      return setUI((x) => (x.overlay?.kind === "detail" ? { ...x, overlay: { ...x.overlay, view: "yaml", diff: false, version: undefined } } : x));
    case "object.describe": {
      // from the table, or switching an open detail view to describe
      if (s.overlay?.kind === "detail") return setUI((x) => ({ ...x, overlay: { ...x.overlay!, view: "describe", diff: false, describeGen: (x.overlay!.describeGen ?? 0) + 1 } }));
      const key = selectedKey(pane);
      if (!key) return;
      return setUI((x) => S.openOverlay(x, { kind: "detail", pane: pane.id, key, view: "describe" }));
    }
    case "object.exec":
      return void prepareAction("exec");
    case "object.edit":
      return void openEdit();
    case "edit.submit":
      return void submitEdit();
    case "edit.back": {
      const e = s.overlay?.kind === "edit" ? s.overlay.edit : undefined;
      if (!e) return;
      if (e.preview) return setUI((x) => S.setEdit(x, (d) => ({ ...d, preview: undefined })));
      // changes are work: the first esc only asks
      if (e.yaml !== e.opened && !e.discarding) return setUI((x) => S.setEdit(x, (d) => ({ ...d, discarding: true })));
      void bridge().editClose(e.session).catch(() => {});
      return setUI(S.closeOverlay);
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
      // the field list goes back to the detail view it came from
      if (s.overlay?.kind === "field" && s.overlay.back) {
        const back = s.overlay.back;
        return setUI((x) => ({ ...x, overlay: back, focus: "detail" }));
      }
      return setUI(S.closeOverlay);
    case "detail.toggleDiff":
      // in describe: diff against the previous describe; elsewhere the object diff (from the newest version)
      return setUI((x) => (x.overlay ? { ...x, overlay: { ...x.overlay, diff: !x.overlay.diff, version: undefined } } : x));
    case "diff.next":
    case "diff.prev":
      return useDiffNav.getState().go?.(cmd === "diff.next" ? "next" : "previous");
    case "diff.older":
    case "diff.newer":
      return setUI((x) => S.stepVersion(x, cmd === "diff.older" ? -1 : 1, useDiffRange.getState().range));
    case "detail.toggleWrap":
      return setUI((x) => ({ ...x, wrap: !x.wrap }));
    case "detail.refresh":
      // re-run describe: the last run becomes the baseline of the diff
      return setUI((x) =>
        x.overlay?.kind === "detail" && x.overlay.view === "describe" ? { ...x, overlay: { ...x.overlay, describeGen: (x.overlay.describeGen ?? 0) + 1 } } : x,
      );
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
      return void runConfirmed();
    case "confirm.cancel":
      // a confirmed edit goes back to its preview, not away
      if (s.overlay?.kind === "confirm" && s.overlay.edit) return reopenEdit(s.overlay.pane, s.overlay.edit);
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

/** Per terminal session: steps to the next/previous match (registered by the open terminal). */
export const finders = new Map<string, (dir: "next" | "prev") => void>();

/**
 * = / ! in the YAML view: the field under the cursor, compared with its
 * value, becomes the pane's CEL filter, applied at once (it's complete, so
 * there's nothing to preview). The detail view closes onto the result.
 */
function filterFromDetail(op: "==" | "!=") {
  const o = useUI.getState().overlay;
  if (o?.kind !== "detail" || o.view === "describe" || o.diff) return;
  const pane = useUI.getState().panes[o.pane];
  if (!pane || cursor.text === undefined) return;
  const leaf = yamlLeaf(cursor.text.split("\n"), cursor.line);
  const expr = leaf && celFromLeaf(leaf, op);
  if (!expr) return flash(pane.id, "no value on this line to filter by", true);
  setUI(S.closeOverlay);
  void applySpec(pane.id, { ...pane.spec, filter: expr });
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

/** Shows a short message in a pane's status line. */
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
  if (!pane.serverId) return;
  const d = paneData.get(pane.serverId);
  const key = d.order[pane.selected - d.offset];
  if (!key) return;
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
 * e, from the table or the detail view: Go reads the object fresh and opens
 * an edit session (refused on read-only contexts, before anyone types).
 */
async function openEdit() {
  const s = useUI.getState();
  const o = s.overlay;
  const fromDetail = o?.kind === "detail";
  const paneId = fromDetail ? o.pane : S.focusedPane(s).id;
  const pane = s.panes[paneId];
  const key = fromDetail ? o.key : pane && selectedKey(pane);
  if (!pane?.serverId || !key) return;
  try {
    const [es, info] = await Promise.all([bridge().editOpen(pane.serverId, key), bridge().rowInfo(pane.serverId, key)]);
    if (useUI.getState().overlay !== o) return void bridge().editClose(es.session).catch(() => {}); // something else meanwhile
    const edit: S.EditState = { session: es.session, key, title: `${info.kind} ${info.name}`, opened: es.yaml, yaml: es.yaml };
    setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "edit", pane: paneId, key, edit }));
  } catch (e) {
    // the detail view would cover the pane's status line
    if (fromDetail && useUI.getState().overlay === o) setUI(S.closeOverlay);
    flash(paneId, errorText(e), true);
  }
}

/** The edit overlay again (back from a confirm, or after a failed write), in the editor or its preview. */
function reopenEdit(paneId: string, edit: S.EditState) {
  setUI((x) => S.setEdit(S.openOverlay(S.closeOverlay(x), { kind: "edit", pane: paneId, key: edit.key, edit }), (e) => e));
}

/**
 * ⌘S / ⌘⏎ in the editor: Go checks the edit and the server dry-runs it; a
 * refusal (bad YAML, webhook, conflict) stays in the editor, else its diff
 * shows. There ⏎ (or ⌘S again) prepares and writes it, confirmed if the
 * context's rule asks for it.
 */
async function submitEdit() {
  const o = useUI.getState().overlay;
  const e = o?.kind === "edit" ? o.edit : undefined;
  const pane = o && useUI.getState().panes[o.pane];
  if (!o || !e || !pane?.serverId) return;
  // a result for text that was changed meanwhile is dropped
  const same = (x: S.UIState) => x.overlay?.kind === "edit" && x.overlay.edit?.session === e.session && x.overlay.edit.yaml === e.yaml && !x.overlay.edit.preview === !e.preview;
  const fail = (err: unknown) => setUI((x) => (same(x) ? S.setEdit(x, (d) => ({ ...d, preview: undefined, error: errorText(err), discarding: false })) : x));
  if (!e.preview) {
    try {
      const preview = await bridge().editCheck(e.session, e.yaml);
      if (preview.noChange) return fail("the server would store nothing new (status, for one, isn't changed by an edit)");
      setUI((x) => (same(x) ? S.setEdit(x, (d) => ({ ...d, preview, error: undefined, discarding: false })) : x));
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
  setUI(S.closeOverlay);
  await proceed(o.pane, e.key, pending, "", undefined, undefined, e);
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

function selectedKey(pane: S.PaneState): string | undefined {
  if (!pane.serverId || pane.term) return undefined;
  const d = paneData.get(pane.serverId);
  return d.order[pane.selected - d.offset];
}

/**
 * ⌘J, on a row (or from its detail view): the jump menu. Opened from the
 * ⌘⏎ menu it takes that menu's place, at the same anchor.
 */
function openJump() {
  const s = useUI.getState();
  const o = s.overlay;
  const fromDetail = o?.kind === "detail";
  const pane = fromDetail ? s.panes[o.pane] : S.focusedPane(s);
  const key = fromDetail ? o.key : pane && selectedKey(pane);
  if (!pane || !key) return;
  const at = o?.kind === "menu" ? o.at : undefined;
  setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "jump", pane: pane.id, key, index: 0, rowIndex: pane.selected, at }));
}

/**
 * v, on a row (or from its detail view): the pane jumps to the events about
 * it, as a jump menu entry would (⌘← goes back to the row). Go builds the
 * target (field selector on the involved object).
 */
async function openEvents() {
  const s = useUI.getState();
  const o = s.overlay;
  const fromDetail = o?.kind === "detail";
  const pane = fromDetail ? s.panes[o.pane] : S.focusedPane(s);
  const key = fromDetail ? o.key : pane && selectedKey(pane);
  if (!pane?.serverId || !key) return;
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

/** Shows a jump target in a pane (pushing its current view) or in a new split below it. */
export async function jumpTo(paneId: string, target: JumpTarget, inSplit: boolean, fromKey?: string) {
  const pane = useUI.getState().panes[paneId];
  if (!pane) return;
  const spec = S.jumpSpec(pane.spec, target);
  if (inSplit) {
    // the new pane opens itself on mount (Pane's effect), like any split
    return setUI((x) => S.splitWith(S.focusPane(x, paneId), spec));
  }
  setUI((x) => S.pushHistory(x, paneId, fromKey));
  await applySpec(paneId, spec);
}

/** ⌘O ⏎: the pane shows spec; a new source pushes its current view (and selected row), as a jump does. */
export async function openSource(paneId: string, spec: S.PaneSpec) {
  const pane = useUI.getState().panes[paneId];
  if (!pane) return;
  setUI((x) => S.openHistory(x, paneId, spec, selectedKey(pane)));
  await applySpec(paneId, spec);
}

/**
 * ⌘← / ⌘→ in the table (or the header's ← / → buttons): the view before the
 * last jump or ⌘O, or forward again to the one just left; the row selected
 * there is selected again. steps: several at once, picked from the history list.
 */
export async function moveHistory(dir: "back" | "forward", paneId = S.focusedPane(useUI.getState()).id, steps = 1) {
  const pane = useUI.getState().panes[paneId];
  if (!pane || pane.term) return;
  const { state, entry } = S.moveHistory(useUI.getState(), pane.id, dir, selectedKey(pane), steps);
  if (!entry) return flash(pane.id, dir === "back" ? "nothing to go back to" : "nothing to go forward to");
  setUI(() => state);
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
  const items = useJump.getState().items;
  if (!s.overlay || items.length === 0) return s;
  let i = s.overlay.index ?? 0;
  for (let n = 0; n < items.length; n++) {
    const j = i + delta;
    if (j < 0 || j >= items.length) break;
    i = j;
    if (jumpable(items[i]!)) return { ...s, overlay: { ...s.overlay, index: i } };
  }
  return s;
}

/** Moves the menu highlight, skipping disabled entries. */
function moveMenu(s: S.UIState, delta: number): S.UIState {
  const items = useMenu.getState().items;
  if (!s.overlay || items.length === 0) return s;
  let i = s.overlay.index ?? 0;
  for (let n = 0; n < items.length; n++) {
    const j = i + delta;
    if (j < 0 || j >= items.length) break;
    i = j;
    if (!items[i]!.disabled) return { ...s, overlay: { ...s.overlay, index: i } };
  }
  return s;
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
  const keep = !!p.serverId && S.sameSource(p.spec, spec);
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
      context: keep ? q.context : undefined,
      kind: keep ? q.kind : undefined,
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
    setUI((x) => S.updatePane(x, paneId, (q) => ({ ...q, serverId: res.pane, context: res.context, kind: res.kind, type: res.type, opening: false })));
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
  const id = useUI.getState().panes[paneId]?.serverId;
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

/** ⇧H in the YAML: how the field under the cursor went over time (needs recording). */
async function openFieldHistory() {
  const o = useUI.getState().overlay;
  if (o?.kind !== "detail" || o.view === "describe" || !o.key) return;
  const pane = useUI.getState().panes[o.pane];
  if (!pane?.serverId || cursor.text === undefined) return;
  if (!paneData.get(pane.serverId).status?.recording) return flash(pane.id, "field history needs record history (⇧R in the table)", true);
  try {
    // the line is one of the YAML view (the object) or of the diff's right side (normalized)
    const fh = await bridge().fieldHistory(pane.serverId, o.key, o.diff ? (o.version ?? 0) : 0, cursor.line, o.diff ? "norm" : "yaml");
    if (!fh.changes.length) return flash(pane.id, `no history of ${fh.path}`, true);
    setUI((x) => ({
      ...x,
      overlay: { kind: "field", pane: pane.id, key: o.key, field: fh, index: fh.changes.length - 1, back: o, restore: o.restore },
      focus: "menu",
    }));
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

/** ⏎ on a field's change: the pane goes to that moment (the detail view closes, the table shows it then). */
function pickField(paneId: string, at: string | undefined) {
  if (!at) return;
  setUI(S.closeOverlay); // the field list (with the detail view behind it)
  void travel(paneId, { to: at });
}
