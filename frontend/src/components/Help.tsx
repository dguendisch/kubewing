import { useEffect, useMemo, useRef } from "react";
import { cheatsheet } from "../keys/cheatsheet";
import { useConfig } from "../store/config";
import { useUI } from "../store/store";

/**
 * ?: every shortcut of the live keymap, so a user's keybindings.yaml is
 * reflected as it is. Esc (or ? again) closes; j/k and the arrows scroll.
 */
export function Help() {
  const kind = useUI((s) => s.overlay?.kind);
  if (kind !== "help") return null;
  return <Sheet />;
}

function Sheet() {
  const bindings = useConfig((s) => s.bindings);
  const dir = useConfig((s) => s.config?.dir);
  const sections = useMemo(() => cheatsheet(bindings), [bindings]);
  const body = useRef<HTMLDivElement>(null);

  // the sheet itself takes focus, so the arrows and PageUp/Down scroll it
  useEffect(() => body.current?.focus(), []);

  return (
    <div role="dialog" aria-modal="true" aria-label="keyboard shortcuts" className="absolute inset-6 z-40 flex flex-col border border-accent bg-bg-elev shadow-dialog">
      <h2 className="shrink-0 border-b border-border px-3 py-1 font-semibold text-fg">keyboard shortcuts</h2>
      <div
        ref={body}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 outline-none"
        onKeyDown={(e) => {
          const step = e.key === "J" || e.key === "j" ? 1 : e.key === "K" || e.key === "k" ? -1 : 0;
          if (step) body.current?.scrollBy({ top: step * 48 });
        }}
      >
        {/* the columns grow with their content: on the scroller itself, its fixed height would overflow into
            extra columns to the right (horizontal scrolling) instead of scrolling down */}
        <div className="columns-2 gap-8">
          {sections.map((s) => (
            <section key={s.title} className="mb-4 break-inside-avoid">
              <h3 className="mb-0.5 border-b border-border text-accent">{s.title}</h3>
              {s.entries.map((e) => (
                // where a key works is a hover hint: inline it would crowd out the label
                <div key={e.label} title={e.when.length ? `works in: ${e.when.join(", ")}` : "works everywhere"} className="flex items-baseline gap-3 py-px">
                  <span className="text-fg">{e.label}</span>
                  <kbd className="ml-auto shrink-0 whitespace-nowrap text-accent">{e.keys.join(" ")}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
      <div className="shrink-0 border-t border-border px-3 py-1 text-fg-muted">esc close · rebind any of these in {dir ? `${dir}/keybindings.yaml` : "keybindings.yaml"}</div>
    </div>
  );
}
