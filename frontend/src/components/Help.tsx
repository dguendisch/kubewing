import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { dispatch } from "../commands";
import { cheatsheet, type Entry } from "../keys/cheatsheet";
import { useConfig } from "../store/config";
import { setUI, useUI } from "../store/store";
import * as S from "../store/state";

/**
 * ?: every shortcut of the live keymap, so a user's keybindings.yaml is
 * reflected as it is. Esc (or ? again) closes; j/k and the arrows scroll.
 * ⌘F opens a find over the labels and chords; ⌘G / ⏎ step the matches.
 */
export function Help() {
  const kind = useUI((s) => s.overlay?.kind);
  if (kind !== "help") return null;
  return <Sheet />;
}

function Sheet() {
  const bindings = useConfig((s) => s.bindings);
  const dir = useConfig((s) => s.config?.dir);
  const find = useUI((s) => s.helpFind);
  const sections = useMemo(() => cheatsheet(bindings), [bindings]);
  const body = useRef<HTMLDivElement>(null);

  // every entry a flat index (with its section title, which it matches on too), so a match can be found and scrolled to
  const entries = useMemo(() => sections.flatMap((s) => s.entries.map((e) => ({ ...e, section: s.title }))), [sections]);
  const query = find?.query.trim().toLowerCase() ?? "";
  const matches = useMemo(
    () => (query ? entries.map((e, i) => (hits(e, e.section, query) ? i : -1)).filter((i) => i >= 0) : []),
    [entries, query],
  );
  // the active match, the stepping wrapped against the live count
  const active = matches.length ? matches[((find!.index % matches.length) + matches.length) % matches.length]! : -1;

  // the sheet itself takes focus, so the arrows and PageUp/Down scroll it (not while finding: the field has it)
  useEffect(() => {
    if (!find) body.current?.focus();
  }, [find]);

  const activeRow = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (active >= 0) activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let flat = -1; // the running flat index, to tag each entry's row
  return (
    <div role="dialog" aria-modal="true" aria-label="keyboard shortcuts" className="absolute inset-6 z-40 flex flex-col border border-accent bg-bg-elev shadow-dialog">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1">
        <h2 className="font-semibold text-fg">keyboard shortcuts</h2>
        {find && <FindBox query={find.query} count={matches.length} active={active < 0 ? -1 : matches.indexOf(active)} />}
      </div>
      <div
        ref={body}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 outline-none"
        onKeyDown={(e) => {
          if (find) return; // the find field owns the keys while it's open
          const step = e.key === "J" || e.key === "j" ? 1 : e.key === "K" || e.key === "k" ? -1 : 0;
          if (step) body.current?.scrollBy({ top: step * 48 });
        }}
      >
        {/* the columns grow with their content: on the scroller itself, its fixed height would overflow into
            extra columns to the right (horizontal scrolling) instead of scrolling down */}
        <div className="columns-2 gap-8">
          {sections.map((s) => {
            // the section matches as a whole when its title does: its heading highlights and its rows stay lit
            const titleHit = query ? s.title.toLowerCase().includes(query) : false;
            return (
              <section key={s.title} className="mb-4 break-inside-avoid">
                <h3 className="mb-0.5 border-b border-border text-accent">{highlight(s.title, query)}</h3>
                {s.entries.map((e) => {
                  flat += 1;
                  const isMatch = query ? titleHit || hits(e, s.title, query) : false;
                  const isActive = flat === active;
                  return (
                    // where a key works is a hover hint: inline it would crowd out the label
                    <div
                      key={e.label}
                      ref={isActive ? activeRow : undefined}
                      title={e.when.length ? `works in: ${e.when.join(", ")}` : "works everywhere"}
                      className={`flex items-baseline gap-3 py-px ${query && !isMatch ? "opacity-30" : ""} ${isActive ? "bg-accent/25" : ""}`}
                    >
                      <span className="text-fg">{highlight(e.label, query)}</span>
                      <kbd className="ml-auto shrink-0 whitespace-nowrap text-accent">{highlight(e.keys.join(" "), query)}</kbd>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
      <div className="shrink-0 border-t border-border px-3 py-1 text-fg-muted">esc close · ⌘F find · rebind any of these in {dir ? `${dir}/keybindings.yaml` : "keybindings.yaml"}</div>
    </div>
  );
}

/** A match: the query appears in the section title, the label, or any of the chords. */
function hits(e: Entry, section: string, query: string): boolean {
  return section.toLowerCase().includes(query) || e.label.toLowerCase().includes(query) || e.keys.join(" ").toLowerCase().includes(query);
}

/** The text with each (case-insensitive) occurrence of the query marked; the whole string when there's none. */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const out: ReactNode[] = [];
  const hay = text.toLowerCase();
  let i = 0;
  for (let at = hay.indexOf(query); at >= 0; at = hay.indexOf(query, i)) {
    if (at > i) out.push(text.slice(i, at));
    out.push(
      <mark key={at} className="bg-accent/40 text-fg">
        {text.slice(at, at + query.length)}
      </mark>,
    );
    i = at + query.length;
  }
  out.push(text.slice(i));
  return out;
}

function FindBox({ query, count, active }: { query: string; count: number; active: number }) {
  const input = useRef<HTMLInputElement>(null);
  // ⌘F again selects the query, so typing replaces it
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const status = !query ? "" : count === 0 ? "no matches" : `${active + 1} of ${count}`;
  return (
    <div role="search" aria-label="find in shortcuts" className="ml-auto flex items-center gap-2">
      <input
        ref={input}
        aria-label="find"
        placeholder="find"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => setUI((s) => S.setHelpFindQuery(s, e.target.value))}
        className={`w-48 rounded border bg-bg px-1.5 py-0.5 text-fg outline-none ${query && count === 0 ? "border-deleted" : "border-border focus:border-accent"}`}
      />
      <span aria-label="matches" className="min-w-16 text-small whitespace-nowrap text-fg-muted">
        {status}
      </span>
      <button type="button" tabIndex={-1} aria-label="previous match" title="previous match (⇧⏎)" disabled={!count} onMouseDown={(e) => e.preventDefault()} onClick={() => dispatch("help.findPrev")} className="px-1 text-fg-muted enabled:hover:text-fg disabled:opacity-40">
        ↑
      </button>
      <button type="button" tabIndex={-1} aria-label="next match" title="next match (⏎)" disabled={!count} onMouseDown={(e) => e.preventDefault()} onClick={() => dispatch("help.findNext")} className="px-1 text-fg-muted enabled:hover:text-fg disabled:opacity-40">
        ↓
      </button>
      <button type="button" tabIndex={-1} aria-label="close find" title="close (esc)" onMouseDown={(e) => e.preventDefault()} onClick={() => dispatch("help.findClose")} className="px-1 text-fg-muted hover:text-fg">
        ✕
      </button>
    </div>
  );
}
