import { Detail } from "./components/Detail";
import { LayoutView } from "./components/Layout";
import { OpenSource } from "./components/OpenSource";
import { useKeys } from "./keys/useKeys";
import { setUI, useUI } from "./store/store";
import * as S from "./store/state";

export function App() {
  useKeys();
  const tabs = useUI((s) => s.tabs);
  const active = useUI((s) => s.activeTab);
  const panes = useUI((s) => s.panes);
  const tab = tabs[active]!;
  return (
    <div className="relative flex h-full flex-col">
      <nav role="tablist" className="flex h-7 shrink-0 items-end gap-px bg-bg pl-20" style={{ ["--wails-draggable" as string]: "drag" }}>
        {tabs.map((t, i) => {
          const p = panes[t.focused];
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={i === active}
              onClick={() => setUI((s) => ({ ...s, activeTab: i }))}
              className={`px-3 py-1 ${i === active ? "bg-bg-elev text-fg" : "text-fg-muted"}`}
            >
              {p ? `${p.spec.resource}${p.spec.namespace ? ` · ${p.spec.namespace}` : ""}` : "…"}
            </button>
          );
        })}
        <button aria-label="new tab" className="px-2 py-1 text-fg-muted" onClick={() => setUI(S.newTab)}>
          +
        </button>
      </nav>
      <main className="min-h-0 flex-1 p-px">
        <LayoutView key={tab.id} node={tab.layout} />
      </main>
      <Detail />
      <OpenSource />
    </div>
  );
}
