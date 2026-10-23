import { useEffect, useRef } from "react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type SerializedDockview } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { fromDockview, sameLayout, toDockview, type DockLayout } from "../store/dock";
import { setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { Pane } from "./Pane";

const components = { pane: ({ api }: IDockviewPanelProps) => <Pane id={api.id} /> };

/**
 * One tab's split layout, rendered by dockview (resizable dividers, drag and
 * drop). The store's split tree stays the source of truth: store changes are
 * pushed with fromJSON (existing panels and their grids are kept), and
 * user rearrangements come back through setLayout. Splitting, closing and
 * focus moves only happen through store commands.
 *
 * Inactive tabs stay mounted but hidden: a hidden dockview has no size, so
 * it neither takes layouts (pixels would be meaningless) nor reports them
 * (they'd come back as equal shares). It syncs from the store when shown.
 *
 * A maximized pane (⌘⇧⏎) is dockview's maximized group: the others are only
 * hidden, so their grids and shells stay as they are. Nothing is read back
 * meanwhile (the hidden panes have no size); the tree is the one from before.
 */
export function Dock({ tabId, active }: { tabId: string; active: boolean }) {
  const api = useRef<DockviewApi>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(false); // visible and in sync with the store
  const layout = useUI((s) => s.tabs.find((t) => t.id === tabId)?.layout);
  const maximized = useUI((s) => s.tabs.find((t) => t.id === tabId)?.maximized);

  // measured from the DOM: right after a hidden tab is shown, dockview's own
  // width/height are stale until its resize observer fires
  const box = () => {
    const r = host.current?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? { width: Math.floor(r.width), height: Math.floor(r.height) } : undefined;
  };
  const sized = () => !!api.current && !!box();
  const storeTab = () => useUI.getState().tabs.find((x) => x.id === tabId);

  const push = () => {
    const a = api.current;
    const t = storeTab();
    const b = box();
    if (!a || !t || !b) return;
    live.current = false; // our own layout calls must not be read back as user changes
    if (a.width !== b.width || a.height !== b.height) a.layout(b.width, b.height);
    // toJSON serializes the layout as it is without the maximized pane
    const shown = fromDockview(a.toJSON() as unknown as DockLayout);
    if (!shown || !sameLayout(shown, t.layout)) {
      a.fromJSON(toDockview(t.layout, t.focused, b) as unknown as SerializedDockview, { reuseExistingPanels: true });
      for (const g of a.groups) g.header.hidden = true; // each pane draws its own header
    }
    const max = t.maximized ? a.getPanel(t.maximized) : undefined;
    if (max && !max.api.isMaximized()) max.api.maximize();
    else if (!max && a.hasMaximizedGroup()) a.exitMaximizedGroup();
    live.current = true;
  };

  // dockview → store: divider drags and drag-and-drop rearrangements
  const pull = () => {
    const a = api.current;
    const t = storeTab();
    if (!a || !t || !live.current || !sized() || t.maximized || a.hasMaximizedGroup()) return;
    const got = fromDockview(a.toJSON() as unknown as DockLayout);
    if (got && !sameLayout(got, t.layout)) setUI((s) => (S.activeTab(s).id === tabId ? S.setLayout(s, got) : s));
  };

  const onReady = (e: DockviewReadyEvent) => {
    api.current = e.api;
    push();
    e.api.onDidLayoutChange(() => {
      if (!sized()) live.current = false; // hidden: stop syncing until shown again
      else if (!live.current) push(); // just became visible (or first sized)
      else pull();
    });
    e.api.onDidMutateLayout((m) => {
      if (m.origin === "user") pull();
    });
    e.api.onDidActivePanelChange((ev) => {
      if (ev.origin === "user" && ev.panel) setUI((s) => (s.panes[ev.panel!.id] ? S.focusPane(s, ev.panel!.id) : s));
    });
  };

  // store → dockview whenever the tree changes, and when the tab is shown again
  useEffect(() => {
    if (!active) {
      live.current = false;
      return;
    }
    push();
  }, [layout, maximized, active]);

  return (
    <div ref={host} className="h-full w-full">
    <DockviewReact
      className="kw-dock h-full w-full"
      components={components}
      onReady={onReady}
      disableFloatingGroups
      disableTabsOverflowList
      dndCompass={false}
    />
    </div>
  );
}
