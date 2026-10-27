import { useEffect, useRef } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { finders } from "../commands";
import { toHex } from "../grid/cells";
import type { TermFind } from "../store/state";
import "@xterm/xterm/css/xterm.css";
import { chord, resolve } from "../keys/keymap";
import { useConfig } from "../store/config";
import { logBuffers } from "./buffer";
import { filterTerms, renderLines } from "./render";

/** Open log terminals by session, for the test introspection hook (inspect.ts). */
export const openLogViews = new Map<string, XTerm>();

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();

function theme(): ITheme {
  return {
    background: token("bg"),
    foreground: token("fg"),
    // read-only pane: hide the cursor by matching it to the background
    cursor: token("bg"),
    cursorAccent: token("bg"),
    selectionBackground: token("bg-hover"),
    red: token("deleted"),
    green: token("added"),
    yellow: token("changed"),
    blue: token("accent"),
    magenta: token("hidden"),
    cyan: token("match"),
  };
}

function decorations(): ISearchOptions["decorations"] {
  const bg = token("bg");
  return {
    matchBackground: toHex(token("changed"), 0.3, bg),
    matchOverviewRuler: toHex(token("changed")),
    activeMatchBackground: toHex(token("accent"), 0.55, bg),
    activeMatchBorder: toHex(token("accent")),
    activeMatchColorOverviewRuler: toHex(token("accent")),
  };
}

interface Props {
  session: string;
  focused: boolean;
  filter: string;
  timestamps: boolean;
  prefix: boolean;
  find?: TermFind;
  onFindResult?: (r: { index: number; count: number }) => void;
  onFocus?: () => void;
}

/**
 * Read-only xterm for a log session. Unlike the exec Terminal it never takes
 * input; it re-renders its whole screen from logs/buffer whenever the buffer,
 * the filter or the timestamp toggle changes, so a filter hides past lines
 * too (stern-style). The buffer lives outside React, so a remount replays it.
 */
export function LogView({ session, focused, filter, timestamps, prefix, find, onFindResult, onFocus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>(undefined);
  const search = useRef<SearchAddon>(undefined);
  const themeGen = useConfig((s) => s.themeGen);
  const cb = useRef({ onFocus, onFindResult });
  cb.current = { onFocus, onFindResult };
  const findRef = useRef(find);
  findRef.current = find;
  // render inputs, read by the redraw effect and the buffer subscription
  const opts = useRef({ filter, timestamps, prefix });
  opts.current = { filter, timestamps, prefix };

  // redraw the whole screen from the buffer with the current filter/options
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const t = new XTerm({
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontSize: 12,
      cursorBlink: false,
      scrollback: 1_000_000,
      theme: theme(),
      disableStdin: true,
      convertEol: false,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    const sa = new SearchAddon({ highlightLimit: 2000 });
    t.loadAddon(sa);
    search.current = sa;
    const of = (f: TermFind): ISearchOptions => ({ caseSensitive: f.caseSensitive, wholeWord: f.wholeWord, regex: f.regex, decorations: decorations() });
    const finder = (dir: "next" | "prev") => {
      const f = findRef.current;
      if (!f?.query) return;
      if (dir === "next") sa.findNext(f.query, of(f));
      else sa.findPrevious(f.query, of(f));
    };
    finders.set(session, finder);
    sa.onDidChangeResults((r) => cb.current.onFindResult?.({ index: r.resultIndex, count: r.resultCount }));
    t.open(host.current!);
    term.current = t;
    openLogViews.set(session, t);
    // every key reaches the app (read-only pane); only mouse selection stays in xterm
    t.attachCustomKeyEventHandler((e) => !(e.type === "keydown" && resolve(chord(e), "logs")));
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetWidth) fit.fit();
    });
    ro.observe(host.current!);
    fit.fit();

    const draw = () => {
      const b = logBuffers.get(session);
      const o = opts.current;
      const atBottom = t.buffer.active.viewportY + t.rows >= t.buffer.active.length - 1;
      t.clear(); // keeps the current line; reset() flickers the viewport
      t.write("\x1b[2J\x1b[H");
      const lines = renderLines(b.lines, { prefix: o.prefix, timestamps: o.timestamps, terms: filterTerms(o.filter), streams: b.streams });
      t.write(lines.join(""));
      if (atBottom) t.scrollToBottom();
    };
    redraw.current = draw;
    draw();
    const unsub = logBuffers.subscribe(session, draw);
    const onFocusIn = () => cb.current.onFocus?.();
    host.current!.addEventListener("focusin", onFocusIn);
    const el = host.current!;
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      unsub();
      ro.disconnect();
      if (openLogViews.get(session) === t) openLogViews.delete(session);
      if (finders.get(session) === finder) finders.delete(session);
      search.current = undefined;
      t.dispose();
      term.current = undefined;
    };
  }, [session]);

  useEffect(() => {
    if (focused) term.current?.focus();
    else term.current?.blur();
  }, [focused]);

  useEffect(() => {
    if (term.current && themeGen) term.current.options.theme = theme();
  }, [themeGen]);

  // a changed filter or timestamp toggle re-renders the screen from the buffer
  useEffect(() => {
    redraw.current();
  }, [filter, timestamps, prefix]);

  // find: live search as the query/options change (as the terminal does)
  const q = find?.open ? find.query : "";
  useEffect(() => {
    const sa = search.current;
    if (!sa) return;
    if (!q) {
      sa.clearDecorations();
      term.current?.clearSelection();
      cb.current.onFindResult?.({ index: -1, count: 0 });
      return;
    }
    const f = findRef.current!;
    sa.clearDecorations();
    const found = sa.findNext(q, { caseSensitive: f.caseSensitive, wholeWord: f.wholeWord, regex: f.regex, decorations: decorations(), incremental: true });
    if (!found) cb.current.onFindResult?.({ index: -1, count: 0 });
  }, [q, find?.caseSensitive, find?.wholeWord, find?.regex]);

  return <div ref={host} data-logview={session} className="h-full w-full overflow-hidden p-1" />;
}
