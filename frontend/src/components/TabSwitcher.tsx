import { useEffect, useState } from "react";
import { useUI } from "../store/store";
import { tabShortcut } from "../store/state";
import { tabTitle } from "./tabTitle";

/** Delay before the overlay shows, so a quick ⌃⇥ tap just flips tabs without a flash. */
const SHOW_AFTER_MS = 120;

/** ⌃⇥ switcher: tabs in most-recently-used order while ⌃ is held. */
export function TabSwitcher() {
  const sw = useUI((s) => s.switcher);
  const mru = useUI((s) => s.mru);
  const tabs = useUI((s) => s.tabs);
  const panes = useUI((s) => s.panes);
  const [visible, setVisible] = useState(false);
  const active = !!sw;

  useEffect(() => {
    if (!active) return setVisible(false);
    const t = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [active]);

  if (!sw || !visible) return null;
  return (
    <div
      role="listbox"
      aria-label="tab switcher"
      className="absolute top-1/3 left-1/2 z-50 flex min-w-72 -translate-x-1/2 flex-col border border-accent bg-bg-elev py-1 shadow-2xl"
    >
      {mru.map((id, i) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) return null;
        return (
          <div
            key={id}
            role="option"
            aria-selected={i === sw.index}
            className={`flex justify-between gap-6 px-3 py-1 ${i === sw.index ? "bg-bg-hover text-fg" : "text-fg-muted"}`}
          >
            <span>{tabTitle(tab, panes[tab.focused])}</span>
            <span>{shortcut(tabs.indexOf(tab), tabs.length)}</span>
          </div>
        );
      })}
    </div>
  );
}

const shortcut = (i: number, count: number) => {
  const n = tabShortcut(i, count);
  return n ? `⌘${n}` : "";
};
