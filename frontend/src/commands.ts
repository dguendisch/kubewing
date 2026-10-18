import type { CommandId } from "./keys/keymap";
import { bridge, paneData, setUI, usePortForwards, useUI } from "./store/store";
import type { ActionKind, Pending } from "./transport/types";
import { useMenu } from "./actions/registry";
import * as S from "./store/state";

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
    case "tab.new":
      return setUI(S.newTab);
    case "tab.close":
      return setUI((x) => S.closeTab(x));
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
      return setUI((x) => ({ ...x, focus: "filter", overlay: undefined }));
    case "filter.blur":
      return setUI((x) => ({ ...x, focus: "table" }));
    case "row.down":
      if (s.overlay?.kind === "forwards") return setUI((x) => moveForward(x, 1));
      if (s.overlay?.kind === "menu") return setUI((x) => moveMenu(x, 1));
      return setUI((x) => S.moveSelection(x, 1, total));
    case "row.up":
      if (s.overlay?.kind === "forwards") return setUI((x) => moveForward(x, -1));
      if (s.overlay?.kind === "menu") return setUI((x) => moveMenu(x, -1));
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
    case "object.menu": {
      const key = selectedKey(pane);
      if (!key) return;
      return setUI((x) => S.openOverlay(S.closeOverlay(x), { kind: "menu", pane: pane.id, key, index: 0, rowIndex: pane.selected }));
    }
    case "menu.run": {
      const o = s.overlay;
      if (o?.kind !== "menu") return;
      const item = useMenu.getState().items[o.index ?? 0];
      if (!item || item.disabled) return;
      setUI(S.closeOverlay);
      return dispatch(item.command); // runs on the selected row, exactly like its shortcut
    }
    case "detail.showYaml":
      return setUI((x) => (x.overlay?.kind === "detail" ? { ...x, overlay: { ...x.overlay, view: "yaml", diff: false } } : x));
    case "object.describe": {
      // from the table, or switching an open detail view to describe
      if (s.overlay?.kind === "detail") return setUI((x) => ({ ...x, overlay: { ...x.overlay!, view: "describe", diff: false, describeGen: (x.overlay!.describeGen ?? 0) + 1 } }));
      const key = selectedKey(pane);
      if (!key) return;
      return setUI((x) => S.openOverlay(x, { kind: "detail", pane: pane.id, key, view: "describe" }));
    }
    case "object.exec":
      return void prepareAction("exec");
    case "object.portForward": {
      const key = selectedKey(pane);
      if (!key) return;
      return setUI((x) => S.openOverlay(x, { kind: "portforward", pane: pane.id, key }));
    }
    case "portforward.list":
      return setUI((x) => (x.overlay?.kind === "forwards" ? S.closeOverlay(x) : S.openOverlay(S.closeOverlay(x), { kind: "forwards", pane: pane.id, index: 0 })));
    case "portforward.stop": {
      const f = usePortForwards.getState().list[s.overlay?.index ?? 0];
      if (f) void bridge().portForwardStop(f.id).catch(() => {});
      return;
    }
    case "detail.close":
      return setUI(S.closeOverlay);
    case "detail.toggleDiff":
      // in describe: diff against the previous describe; elsewhere the object diff
      return setUI((x) => (x.overlay ? { ...x, overlay: { ...x.overlay, diff: !x.overlay.diff } } : x));
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
      return void runConfirmed();
    case "confirm.cancel":
      return setUI(S.closeOverlay);
  }
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
    if (pending.needsConfirm) setUI((x) => S.openOverlay(x, { kind: "confirm", pane: pane.id, key, pending }));
    else await execute(pane.id, pending);
  } catch (e) {
    flash(pane.id, errorText(e), true);
  }
}

async function runConfirmed() {
  const o = useUI.getState().overlay;
  if (o?.kind !== "confirm" || !o.pending) return;
  setUI(S.closeOverlay);
  try {
    await execute(o.pane, o.pending);
  } catch (e) {
    flash(o.pane, errorText(e), true);
  }
}

async function execute(paneId: string, p: Pending) {
  switch (p.action.kind) {
    case "delete":
      await bridge().delete(p.token);
      return flash(paneId, `deleted ${p.action.resource}/${p.action.name}`);
    case "exec": {
      const r = await bridge().execStart(p.token, "", 80, 24);
      const term: S.Term = { session: r.session, pod: r.pod, container: r.container, context: r.context };
      return setUI((x) => S.openTerminal(x, term, paneId));
    }
  }
}

function selectedKey(pane: S.PaneState): string | undefined {
  if (!pane.serverId || pane.term) return undefined;
  const d = paneData.get(pane.serverId);
  return d.order[pane.selected - d.offset];
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

function moveForward(s: S.UIState, delta: number): S.UIState {
  const n = usePortForwards.getState().list.length;
  if (!s.overlay || n === 0) return s;
  const index = Math.max(0, Math.min(n - 1, (s.overlay.index ?? 0) + delta));
  return { ...s, overlay: { ...s.overlay, index } };
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e);

/** Applies a new spec to a pane: reuses the server pane if only stages changed. */
export async function applySpec(paneId: string, spec: S.PaneSpec) {
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
      serverId: keep ? q.serverId : undefined,
      context: keep ? q.context : undefined,
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
    setUI((x) => S.updatePane(x, paneId, (q) => ({ ...q, serverId: res.pane, context: res.context, opening: false })));
  } catch (e) {
    setUI((x) => S.updatePane(x, paneId, (q) => ({ ...q, error: String((e as Error).message ?? e), serverId: undefined, opening: false })));
  }
}
