import { rowAt } from "./grid/rowcache";
import { shownDescribe } from "./components/Detail";
import { openTerminals } from "./term/Terminal";
import { useConfig } from "./store/config";
import { paneData, useUI } from "./store/store";
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
    tabs: s.tabs.map((t) => ({ id: t.id, layout: t.layout, focused: t.focused })),
    focus: s.focus,
    focusedPane: tab.focused,
    overlays: [...(s.overlay ? [s.overlay.kind] : []), ...(s.switcher ? ["switcher"] : [])],
    mru: s.mru,
    switcher: s.switcher,
    overlay: s.overlay,
    describe: s.overlay?.kind === "detail" && s.overlay.view === "describe" ? shownDescribe : undefined,
    // per session: scrollback setting, lines held (screen + scrollback) and the oldest line's text
    terminals: Object.fromEntries(
      [...openTerminals].map(([id, t]) => {
        const b = t.buffer.active;
        return [id, { scrollback: t.options.scrollback, lines: b.length, first: b.getLine(0)?.translateToString(true) }];
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
            pipeline: S.pipelineYAML(p.spec),
            serverId: p.serverId,
            error: p.error,
            selected: p.selected,
            total: d?.total ?? 0,
            status: d?.status,
            columns: d?.columns.map((c) => c.name) ?? [],
            rows: d ? d.order.map((_, i) => rowAt(d, d.offset + i)).filter(Boolean) : [],
          },
        ];
      }),
    ),
  };
}
