import { ConfigErrors } from "./components/ConfigErrors";
import { Confirm, ConfirmClosePane, ConfirmCloseTab } from "./components/Confirm";
import { ContainerPicker } from "./components/ContainerPicker";
import { CellPicker } from "./components/CellPicker";
import { ContextMenu } from "./components/ContextMenu";
import { JumpMenu } from "./components/JumpMenu";
import { HistoryList } from "./components/HistoryNav";
import { FieldList } from "./components/Travel";
import { ErrorDetail } from "./components/ErrorDetail";
import { DebugDialog } from "./components/Debug";
import { ColumnsDialog } from "./components/Columns";
import { OpsPodDialog } from "./components/OpsPod";
import { LogsDialog } from "./logs/LogsDialog";
import { PortForwardDialog, PortForwardList } from "./components/PortForward";
import { Dock } from "./components/Dock";
import { DragPreview } from "./components/PaneDrag";
import { Help } from "./components/Help";
import { OpenSource } from "./components/OpenSource";
import { ClusterPicker } from "./components/ClusterPicker";
import { TabSwitcher } from "./components/TabSwitcher";
import { tabTitle } from "./components/tabTitle";
import { NameField } from "./components/NameField";
import { startTabDrag, useTabDrag } from "./components/TabDrag";
import { dispatch } from "./commands";
import { prettyKey } from "./keys/keymap";
import { useKeys } from "./keys/useKeys";
import { useConfig } from "./store/config";
import { useRules } from "./store/rules";
import { setUI, usePortForwards, useUI } from "./store/store";
import * as S from "./store/state";

const noDrag = { ["--wails-draggable" as string]: "no-drag" };

export function App() {
  useKeys();
  const tabs = useUI((s) => s.tabs);
  const active = useUI((s) => s.activeTab);
  const panes = useUI((s) => s.panes);
  const rules = useRules();
  const forwards = usePortForwards((s) => s.list.length);
  // the live key (keybindings.yaml may rebind or unbind it)
  const listKey = useConfig((c) => c.bindings.find((b) => b.command === "portforward.list"));
  const listKeyText = listKey && prettyKey(listKey.key);
  const tab = tabs[active]!;
  const dragged = useTabDrag((d) => d.tab);
  const renaming = useUI((s) => (s.overlay?.kind === "renameTab" ? s.overlay.tabId : undefined));
  return (
    <div className="relative flex h-full flex-col">
      <nav role="tablist" className="flex h-7 shrink-0 items-end gap-px bg-bg pl-20" style={{ ["--wails-draggable" as string]: "drag" }}>
        {tabs.map((t, i) => {
          const p = panes[t.focused];
          const n = S.tabShortcut(i, tabs.length);
          const title = tabTitle(t, p, p?.context ? rules[p.context] : undefined);
          const shortcut = n && (
            <span aria-hidden className="text-[11px] text-fg-muted">
              ⌘{n}
            </span>
          );
          const className = `flex items-baseline gap-2 py-1 pr-3 pl-6 ${i === active ? "bg-bg-elev text-fg" : "text-fg-muted"} ${t.id === dragged ? "opacity-70" : ""}`;
          // on the tab's left, not its right: closing tab after tab, the next one slides under the pointer, × included
          const close = (
            <button
              type="button"
              aria-label={`close tab ${title}`}
              title="close tab (⌘W)"
              className="absolute top-1/2 left-1.5 hidden size-4 -translate-y-1/2 items-center justify-center rounded text-[11px] leading-none text-fg-muted group-hover:flex hover:bg-fg/15 hover:text-fg"
              onClick={() => setUI((s) => S.requestCloseTab(s, t.id))}
            >
              ✕
            </button>
          );
          // a field can't sit in a button: while named, the tab is a plain element around it
          if (renaming === t.id)
            return (
              <div key={t.id} className="group relative flex" style={noDrag}>
                <div role="tab" data-tab={t.id} aria-selected={i === active} className={className}>
                  <NameField label="tab name" initial={t.name ?? ""} onName={(name) => (s) => S.nameTab(s, t.id, name)} />
                  {shortcut}
                </div>
                {close}
              </div>
            );
          return (
            // not a window drag handle: dragging reorders the tabs, and Wails would take a double-click to zoom the window
            <div key={t.id} className="group relative flex" style={noDrag}>
              <button
                role="tab"
                data-tab={t.id}
                aria-selected={i === active}
                aria-keyshortcuts={n ? `Meta+${n}` : undefined}
                title={t.name ? undefined : "double-click to name the tab (⌘⇧I)"}
                onClick={() => setUI((s) => ({ ...s, activeTab: i }))}
                onPointerDown={(e) => {
                  if (e.button === 0) startTabDrag(t.id, e.nativeEvent);
                }}
                onDoubleClick={() => setUI((s) => S.renameTab({ ...s, activeTab: i }, t.id))}
                className={className}
              >
                {title}
                {shortcut}
              </button>
              {close}
            </div>
          );
        })}
        <button aria-label="new tab" data-new-tab className="px-2 py-1 text-fg-muted" onClick={() => setUI(S.newTab)}>
          +
        </button>
        {forwards ? (
          <button
            type="button"
            aria-label="active port-forwards"
            title={`port-forwards${listKeyText ? ` (${listKeyText})` : ""}`}
            className="ml-auto self-center rounded px-3 text-fg-muted hover:text-fg"
            onClick={() => dispatch("portforward.list")}
          >
            ⇄ {forwards}
          </button>
        ) : null}
      </nav>
      <ConfigErrors />
      <main className="relative min-h-0 flex-1 p-px">
        {/* every tab stays mounted (hidden when inactive): dockview and the grids keep their state */}
        {tabs.map((t) => (
          <div key={t.id} data-tab-area={t.id} className="absolute inset-px" hidden={t.id !== tab.id}>
            <Dock tabId={t.id} active={t.id === tab.id} />
          </div>
        ))}
      </main>
      <FieldList />
      <OpenSource />
      <ClusterPicker />
      <Confirm />
      <ConfirmCloseTab />
      <ConfirmClosePane />
      <PortForwardDialog />
      <PortForwardList />
      <ContextMenu />
      <JumpMenu />
      <HistoryList />
      <ErrorDetail />
      <ContainerPicker />
      <CellPicker />
      <DebugDialog />
      <OpsPodDialog />
      <LogsDialog />
      <ColumnsDialog />
      <TabSwitcher />
      <Help />
      <DragPreview />
    </div>
  );
}
