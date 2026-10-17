import type { CommandId } from "./keys/keymap";
import { bridge, paneData, setUI, useUI } from "./store/store";
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
      return setUI((x) => S.moveSelection(x, 1, total));
    case "row.up":
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
      if (!pane.serverId) return;
      const d = paneData.get(pane.serverId);
      const key = d.order[pane.selected - d.offset];
      if (!key) return;
      return setUI((x) => S.openOverlay(x, { kind: "detail", pane: pane.id, key }));
    }
    case "detail.close":
      return setUI(S.closeOverlay);
    case "detail.toggleDiff":
      return setUI((x) => (x.overlay ? { ...x, overlay: { ...x.overlay, diff: !x.overlay.diff } } : x));
    case "source.open":
      return setUI((x) => S.openOverlay(x, { kind: "open", pane: pane.id }));
  }
}

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
    setUI((x) => S.updatePane(x, paneId, (q) => ({ ...q, serverId: res.pane, opening: false })));
  } catch (e) {
    setUI((x) => S.updatePane(x, paneId, (q) => ({ ...q, error: String((e as Error).message ?? e), serverId: undefined, opening: false })));
  }
}
