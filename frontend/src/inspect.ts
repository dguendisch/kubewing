import { rowAt } from "./grid/rowcache";
import { useTextSel } from "./grid/textsel";
import { shownDescribe } from "./components/Detail";
import { shownDecode } from "./components/Decode";
import { cursor, decodeCursor } from "./editor/Viewer";
import { openTerminals } from "./term/Terminal";
import { openLogViews } from "./logs/LogView";
import { logBuffers } from "./logs/buffer";
import { useConfig } from "./store/config";
import { paneData, useColumns, useUI } from "./store/store";
import * as S from "./store/state";

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
    mru: s.mru,
    switcher: s.switcher,
    overlay: s.overlay,
    describe: s.overlay?.kind === "detail" && s.overlay.view === "describe" ? shownDescribe : undefined,
    decoded: s.overlay?.kind === "decode" ? shownDecode : undefined,
    // the cursor lines (0-based) of the detail view and of a decode over it
    cursors: { detail: cursor.line, decode: decodeCursor.line },
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
