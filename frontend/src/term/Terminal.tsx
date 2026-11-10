import { useEffect, useRef } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { finders } from "../commands";
import { toHex } from "../grid/cells";
import type { TermFind } from "../store/state";
import "@xterm/xterm/css/xterm.css";
import { chord, resolve } from "../keys/keymap";
import { claimFocus } from "../editor/focus";
import { useConfig } from "../store/config";
import { font } from "../store/font";
import { DEFAULT_SCROLLBACK, sessions } from "./sessions";

/** Open terminals by session, for the test introspection hook (inspect.ts). */
export const openTerminals = new Map<string, XTerm>();

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();

function theme(): ITheme {
  return {
    background: token("bg"),
    foreground: token("fg"),
    cursor: token("accent"),
    cursorAccent: token("bg"),
    selectionBackground: token("bg-hover"),
    red: token("deleted"),
    green: token("added"),
    yellow: token("changed"),
    magenta: token("hidden"),
  };
}

/** Match highlights from theme tokens; xterm takes #RRGGBB only. */
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
  /** The pane's find bar state; a changed query or option searches again. */
  find?: TermFind;
  /** Find results: index of the active match (-1 = over the highlight limit), count. */
  onFindResult?: (r: { index: number; count: number }) => void;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onExit?: (code: number | string) => void;
  onFocus?: () => void;
}

/**
 * xterm.js terminal for one session. Every key goes to the shell except the
 * app's ⌘ chords (see keymap.terminalReserved), which xterm lets through to
 * the global handler. Output streams from `sessions`, bypassing React.
 */
export function Terminal({ session, focused, find, onFindResult, onInput, onResize, onExit, onFocus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>(undefined);
  const search = useRef<SearchAddon>(undefined);
  const refit = useRef<() => void>(() => {});
  const themeGen = useConfig((s) => s.themeGen);
  const scrollback = useConfig((s) => s.config?.config.terminal?.scrollback ?? DEFAULT_SCROLLBACK);
  const cb = useRef({ onInput, onResize, onExit, onFocus, onFindResult });
  cb.current = { onInput, onResize, onExit, onFocus, onFindResult };
  const findRef = useRef(find);
  findRef.current = find;

  useEffect(() => {
    const t = new XTerm({
      fontFamily: font().family,
      fontSize: font().size,
      cursorBlink: true,
      scrollback,
      theme: theme(),
      macOptionIsMeta: true,
      allowProposedApi: true, // search decorations (all matches highlighted)
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    const sa = new SearchAddon({ highlightLimit: 2000 });
    t.loadAddon(sa);
    search.current = sa;
    const opts = (f: TermFind): ISearchOptions => ({ caseSensitive: f.caseSensitive, wholeWord: f.wholeWord, regex: f.regex, decorations: decorations() });
    const finder = (dir: "next" | "prev") => {
      const f = findRef.current;
      if (!f?.query) return;
      if (dir === "next") sa.findNext(f.query, opts(f));
      else sa.findPrevious(f.query, opts(f));
    };
    finders.set(session, finder);
    sa.onDidChangeResults((r) => cb.current.onFindResult?.({ index: r.resultIndex, count: r.resultCount }));
    t.open(host.current!);
    term.current = t;
    openTerminals.set(session, t);
    // false = xterm ignores the key; the app's capture-phase handler has it already
    t.attachCustomKeyEventHandler((e) => !(e.type === "keydown" && resolve(chord(e), "terminal")));
    const subs = [t.onData((d) => cb.current.onInput(d)), t.onResize(({ cols, rows }) => cb.current.onResize(cols, rows))];
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetWidth) fit.fit();
    });
    ro.observe(host.current!);
    fit.fit();
    refit.current = () => {
      if (host.current?.offsetWidth) fit.fit();
    };
    cb.current.onResize(t.cols, t.rows);
    const detach = sessions.attach(session, (c) => {
      if (c instanceof Uint8Array) t.write(c);
      else {
        t.write(`\r\n\x1b[2m[process exited: ${c.exit}]\x1b[0m\r\n`);
        cb.current.onExit?.(c.exit);
      }
    });
    const onFocusIn = () => cb.current.onFocus?.();
    host.current!.addEventListener("focusin", onFocusIn);
    const el = host.current!;
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      detach();
      ro.disconnect();
      subs.forEach((s) => s.dispose());
      if (openTerminals.get(session) === t) openTerminals.delete(session);
      // a pane moved to another tab mounts its new terminal before this one goes
      if (finders.get(session) === finder) finders.delete(session);
      search.current = undefined;
      t.dispose();
      term.current = undefined;
    };
  }, [session]);

  // claimed like an editor's focus: a sibling pane closing (⌃D in another shell) re-parents this one, dropping the browser focus
  useEffect(() => {
    if (!focused) {
      term.current?.blur();
      return;
    }
    term.current?.focus();
    return claimFocus(() => term.current?.focus());
  }, [focused]);

  // the find bar closed: back to the prompt, as Monaco returns to the cursor (a match may be far up)
  const findOpen = !!find?.open;
  useEffect(() => {
    if (!findOpen) term.current?.scrollToBottom();
  }, [findOpen]);

  // a reloaded config: colors and font (the DOM renderer takes ligatures from the page's CSS); a new cell size refits the grid
  useEffect(() => {
    const t = term.current;
    if (!t || !themeGen) return;
    t.options.theme = theme();
    const f = font();
    if (t.options.fontFamily !== f.family || t.options.fontSize !== f.size) {
      t.options.fontFamily = f.family;
      t.options.fontSize = f.size;
      refit.current();
    }
  }, [themeGen]);

  // live search: a changed query or option searches again from where the view is (incremental, as Monaco);
  // closing the bar removes the highlights
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
    // addon bug (0.16): findNext stores the new options before comparing them with the last ones,
    // so a changed option alone never re-counts or re-highlights; clearing resets its cached term
    sa.clearDecorations();
    const found = sa.findNext(q, { caseSensitive: f.caseSensitive, wholeWord: f.wholeWord, regex: f.regex, decorations: decorations(), incremental: true });
    if (!found) cb.current.onFindResult?.({ index: -1, count: 0 });
  }, [q, find?.caseSensitive, find?.wholeWord, find?.regex]);

  // ⌘⇧, applies a changed scrollback to open terminals too
  useEffect(() => {
    if (term.current) term.current.options.scrollback = scrollback;
  }, [scrollback]);

  // the padding sits on a wrapper: FitAddon sizes rows by the host's computed height, which with
  // border-box includes the host's own padding, so a padded host lost the bottom row by up to 8px
  return (
    <div className="h-full w-full overflow-hidden p-1">
      <div ref={host} data-terminal={session} className="h-full w-full overflow-hidden" />
    </div>
  );
}
