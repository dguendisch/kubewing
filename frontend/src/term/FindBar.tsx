import { useEffect, useRef } from "react";
import { dispatch } from "../commands";
import { setUI, useUI } from "../store/store";
import * as S from "../store/state";

/**
 * ⌘F in a terminal pane: find in its output and scrollback, as Monaco's
 * find widget. Matches highlight while typing; ⏎ / ⇧⏎ (or ⌘G / ⌘⇧G, also
 * from the shell) step, Aa / ab / .* toggle case, whole word and regex
 * (⌥⌘C / ⌥⌘W / ⌥⌘R in the field), Esc closes back to the shell.
 */
export function FindBar({ paneId, result, kind = "term" }: { paneId: string; result?: { index: number; count: number }; kind?: "term" | "logs" }) {
  const isLogs = kind === "logs";
  const findCtx = isLogs ? "logsfind" : "termfind";
  const cmdFind = isLogs ? "logs.findNext" : "term.findNext";
  const cmdPrev = isLogs ? "logs.findPrev" : "term.findPrev";
  const cmdClose = isLogs ? "logs.findClose" : "term.findClose";
  const find = useUI((s) => (isLogs ? s.panes[paneId]?.logs?.find : s.panes[paneId]?.term?.find));
  const focused = useUI((s) => s.focus === findCtx && S.activeTab(s).focused === paneId);
  const input = useRef<HTMLInputElement>(null);

  // ⌘F again while open selects the query, so typing replaces it
  useEffect(() => {
    if (focused && input.current && document.activeElement !== input.current) {
      input.current.focus();
      input.current.select();
    }
  }, [focused]);

  if (!find?.open) return null;
  const set = (f: (x: S.TermFind) => S.TermFind) => setUI((s) => (isLogs ? S.updateLogFind(s, paneId, f) : S.updateFind(s, paneId, f)));
  const toggle = (k: "caseSensitive" | "wholeWord" | "regex") => set((x) => ({ ...x, [k]: !x[k] }));
  // -1 index: more matches than are highlighted (the addon's limit)
  const count = !find.query ? "" : !result || result.count === 0 ? "no results" : result.index < 0 ? `${result.count}+ matches` : `${result.index + 1} of ${result.count}`;
  const opt = (k: "caseSensitive" | "wholeWord" | "regex", label: string, title: string) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={title}
      aria-pressed={find[k]}
      title={title}
      onMouseDown={(e) => e.preventDefault()} // keep focus in the field
      onClick={() => toggle(k)}
      className={`rounded px-1 font-mono text-[11px] leading-tight ${find[k] ? "bg-accent/25 text-fg outline outline-accent" : "text-fg-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );
  const step = (cmd: "term.findNext" | "term.findPrev" | "logs.findNext" | "logs.findPrev", label: string, title: string) => (
    <button type="button" tabIndex={-1} aria-label={title} title={title} disabled={!result?.count} onMouseDown={(e) => e.preventDefault()} onClick={() => dispatch(cmd)} className="px-1 text-fg-muted enabled:hover:text-fg disabled:opacity-40">
      {label}
    </button>
  );
  return (
    <div
      role="search"
      aria-label="find in terminal"
      className="absolute top-1 right-4 z-10 flex items-center gap-1 border border-border bg-bg-elev px-1.5 py-1 shadow-lg"
      onMouseDown={() => setUI((s) => ({ ...S.focusPane(s, paneId), focus: findCtx }))}
    >
      <input
        ref={input}
        aria-label="find"
        placeholder="find"
        spellCheck={false}
        autoComplete="off"
        value={find.query}
        onChange={(e) => set((x) => ({ ...x, query: e.target.value }))}
        onFocus={() => setUI((s) => (s.focus === findCtx ? s : { ...S.focusPane(s, paneId), focus: findCtx }))}
        onKeyDown={(e) => {
          // Monaco's toggles; the rest (⏎, ⇧⏎, Esc, ⌘G) goes through the keymap
          if (e.altKey && e.metaKey && ["KeyC", "KeyW", "KeyR"].includes(e.code)) {
            e.preventDefault();
            toggle(e.code === "KeyC" ? "caseSensitive" : e.code === "KeyW" ? "wholeWord" : "regex");
          }
        }}
        className={`w-48 rounded border bg-bg px-1.5 py-0.5 text-fg outline-none ${find.query && result?.count === 0 ? "border-deleted" : "border-border focus:border-accent"}`}
      />
      {opt("caseSensitive", "Aa", "match case (⌥⌘C)")}
      {opt("wholeWord", "ab", "whole word (⌥⌘W)")}
      {opt("regex", ".*", "regular expression (⌥⌘R)")}
      <span aria-label="matches" className="min-w-20 px-1 text-[11px] whitespace-nowrap text-fg-muted">
        {count}
      </span>
      {step(cmdPrev, "↑", "previous match (⇧⏎)")}
      {step(cmdFind, "↓", "next match (⏎)")}
      <button type="button" tabIndex={-1} aria-label="close find" title="close (esc)" onMouseDown={(e) => e.preventDefault()} onClick={() => dispatch(cmdClose)} className="px-1 text-fg-muted hover:text-fg">
        ✕
      </button>
    </div>
  );
}
