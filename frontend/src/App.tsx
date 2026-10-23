import { ConfigErrors } from "./components/ConfigErrors";
import { Confirm, ConfirmCloseTab } from "./components/Confirm";
import { ContainerPicker } from "./components/ContainerPicker";
import { ContextMenu } from "./components/ContextMenu";
import { DebugDialog } from "./components/Debug";
import { OpsPodDialog } from "./components/OpsPod";
import { PortForwardDialog, PortForwardList } from "./components/PortForward";
import { Detail } from "./components/Detail";
import { Edit } from "./components/Edit";
import { Dock } from "./components/Dock";
import { Help } from "./components/Help";
import { OpenSource } from "./components/OpenSource";
import { TabSwitcher } from "./components/TabSwitcher";
import { tabTitle } from "./components/tabTitle";
import { dispatch } from "./commands";
import { prettyKey } from "./keys/keymap";
import { useKeys } from "./keys/useKeys";
import { useConfig } from "./store/config";
import { useRules } from "./store/rules";
import { setUI, usePortForwards, useUI } from "./store/store";
import * as S from "./store/state";

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
  return (
    <div className="relative flex h-full flex-col">
      <nav role="tablist" className="flex h-7 shrink-0 items-end gap-px bg-bg pl-20" style={{ ["--wails-draggable" as string]: "drag" }}>
        {tabs.map((t, i) => {
          const p = panes[t.focused];
          const n = S.tabShortcut(i, tabs.length);
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={i === active}
              aria-keyshortcuts={n ? `Meta+${n}` : undefined}
              onClick={() => setUI((s) => ({ ...s, activeTab: i }))}
              className={`flex items-baseline gap-2 px-3 py-1 ${i === active ? "bg-bg-elev text-fg" : "text-fg-muted"}`}
            >
              {tabTitle(p, p?.context ? rules[p.context] : undefined)}
              {n && (
                <span aria-hidden className="text-[11px] text-fg-muted">
                  ⌘{n}
                </span>
              )}
            </button>
          );
        })}
        <button aria-label="new tab" className="px-2 py-1 text-fg-muted" onClick={() => setUI(S.newTab)}>
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
          <div key={t.id} className="absolute inset-px" hidden={t.id !== tab.id}>
            <Dock tabId={t.id} active={t.id === tab.id} />
          </div>
        ))}
      </main>
      <Detail />
      <Edit />
      <OpenSource />
      <Confirm />
      <ConfirmCloseTab />
      <PortForwardDialog />
      <PortForwardList />
      <ContextMenu />
      <ContainerPicker />
      <DebugDialog />
      <OpsPodDialog />
      <TabSwitcher />
      <Help />
    </div>
  );
}
