import { rowAt } from "./grid/rowcache";
import { useTextSel } from "./grid/textsel";
import { shownDecode, shownDescribe } from "./components/ObjectPane";
import { cursors } from "./editor/Viewer";
import { openTerminals } from "./term/Terminal";
import { openLogViews } from "./logs/LogView";
import { logBuffers } from "./logs/buffer";
import { useConfig } from "./store/config";
import { paneData, useColumns, useUI } from "./store/store";
import * as S from "./store/state";
import { paneIds } from "./store/layout";

const paneIdsOf = (t: S.Tab) => paneIds(t.layout);

/**
 * Test introspection hook: app state as data (layout, focus, panes, visible
 * rows, overlays). Exposed as window.__kw.inspect() in non-production builds.
 */
export function inspect() {
  const s = useUI.getState();
  const tab = S.activeTab(s);
  const c = useConfig.getState();
  return {
    config: { dir: c.config?.dir, errors: c.dismissed ? [] : c.errors, themeGen: c.themeGen },
    activeTab: s.activeTab,
    tabs: s.tabs.map((t) => ({ id: t.id, layout: t.layout, focused: t.focused, maximized: t.maximized })),
    focus: s.focus,
    focusedPane: tab.focused,
    overlays: [...(s.overlay ? [s.overlay.kind] : []), ...(s.switcher ? ["switcher"] : [])],
    // the active tab's object views, by pane: in place ("detail") or in a split ("split")
    objects: Object.fromEntries(
      paneIdsOf(tab).flatMap((id) => {
        const o = s.panes[id]?.object;
        return o ? [[id, { key: o.key, view: o.view, diff: !!o.diff, split: !!o.split, from: o.from, follow: !!o.follow, followOff: o.followOff, decoded: o.decode?.levels.length ?? 0, editing: !!o.edit, title: o.title }]] : [];
      }),
    ),
    mru: s.mru,
    switcher: s.switcher,
    overlay: s.overlay,
    // the focused pane's object view: what it shows, its describe or decoded value, and its cursor line (0-based)
    object: S.focusedPane(s).object,
    describe: S.focusedPane(s).object?.view === "describe" ? shownDescribe.get(tab.focused) : undefined,
    decoded: S.focusedPane(s).object?.decode ? shownDecode.get(tab.focused) : undefined,
    cursor: cursors.get(tab.focused)?.line ?? 0,
    decodeCursor: cursors.get(`${tab.focused}/decode`)?.line ?? 0,
    editCursor: cursors.get(`${tab.focused}/edit`)?.line ?? 0,
    // per session: scrollback setting, lines held (screen + scrollback) and the oldest line's text
    terminals: Object.fromEntries(
      [...openTerminals].map(([id, t]) => {
        const b = t.buffer.active;
        return [id, { scrollback: t.options.scrollback, lines: b.length, first: b.getLine(0)?.translateToString(true) }];
      }),
    ),
    // per log session: lines buffered, streams followed, the rendered screen text and the viewport's
    // scroll position (viewportY: first row shown; at the bottom when viewportY + rows >= length)
    logs: Object.fromEntries(
      [...openLogViews].map(([id, t]) => {
        const buf = logBuffers.get(id);
        const b = t.buffer.active;
        const screen: string[] = [];
        for (let i = 0; i < b.length; i++) {
          const line = b.getLine(i)?.translateToString(true);
          if (line) screen.push(line);
        }
        return [id, { lines: buf.lines.length, streams: buf.streams, dropped: buf.dropped, screen: screen.join("\n"), viewportY: b.viewportY, length: b.length, rows: t.rows }];
      }),
    ),
    panes: Object.fromEntries(
      Object.values(s.panes).map((p) => {
        const d = p.serverId ? paneData.get(p.serverId) : undefined;
        return [
          p.id,
          {
            spec: p.spec,
            term: p.term,
            logs: p.logs,
            object: p.object,
            leased: p.leased,
            pipeline: S.pipelineYAML(p.spec),
            serverId: p.serverId,
            error: p.error,
            selected: p.selected,
            type: p.type,
            // the type's column settings (columns.yaml)
            view: p.type ? useColumns.getState().types[p.type] : undefined,
            total: d?.total ?? 0,
            status: d?.status,
            columns: d?.columns.map((c) => c.name) ?? [],
            rows: d ? d.order.map((_, i) => rowAt(d, d.offset + i)).filter(Boolean) : [],
            // the text selected in a cell (double-click, triple-click, drag)
            textSel: p.serverId ? useTextSel.getState()[p.serverId] : undefined,
          },
        ];
      }),
    ),
  };
}
