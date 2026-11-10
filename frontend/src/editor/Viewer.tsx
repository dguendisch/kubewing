import { useEffect, useRef } from "react";
import { create } from "zustand";
import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { useConfig } from "../store/config";
import { font } from "../store/font";
import { bridge, useUI } from "../store/store";
import { showBlame, type BlameOf, type BlameState } from "./blame";
import { changeIndex } from "./diffnav";
import { claimFocus } from "./focus";
import { loadMonaco, type MonacoApi } from "./load";

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();

/** Monaco theme from the CSS theme tokens (Monaco can't read CSS variables). */
export function defineTheme(m: MonacoApi) {
  const c = (n: string) => token(n);
  m.editor.defineTheme("kubewing", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "type", foreground: c("accent").replace("#", "") },
      { token: "string", foreground: c("added").replace("#", "") },
      { token: "number", foreground: c("changed").replace("#", "") },
      { token: "comment", foreground: c("fg-muted").replace("#", "") },
    ],
    colors: {
      "editor.background": c("bg-elev"),
      "editor.foreground": c("fg"),
      "editorLineNumber.foreground": c("fg-muted"),
      "editor.selectionBackground": c("bg-hover"),
      "editorWidget.background": c("bg"),
      "editorWidget.border": c("border"),
      "focusBorder": c("accent"),
      "diffEditor.insertedTextBackground": `${c("added")}33`,
      "diffEditor.removedTextBackground": `${c("deleted")}33`,
      "diffEditor.insertedLineBackground": `${c("added")}1a`,
      "diffEditor.removedLineBackground": `${c("deleted")}1a`,
    },
  });
  m.editor.setTheme("kubewing");
}

/** The configured font (config.yaml font), for new editors and, on a reload, open ones. */
export function fontOptions(): Monaco.editor.IEditorOptions {
  const f = font();
  return { fontFamily: f.family, fontSize: f.size, fontLigatures: f.ligatures };
}

/**
 * Applies a reloaded font to an editor: Monaco measures glyphs once per
 * font, so a changed font is measured again (and the font loaded by then).
 */
export function updateFont(m: MonacoApi, ed: { updateOptions(o: Monaco.editor.IEditorOptions): void }) {
  ed.updateOptions(fontOptions());
  m.editor.remeasureFonts();
}

/** Options of every editor (the font's: fontOptions()). */
export const common: Monaco.editor.IEditorOptions = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "none",
  folding: true,
  stickyScroll: { enabled: true },
  contextmenu: true,
};

/**
 * Per viewer slot (see Props.slot): the YAML shown and the cursor line
 * (0-based) there, for commands that act on "the line under the cursor"
 * (= / ! filters, ⏎ decode, ⇧H field history).
 */
export type Cursor = { text?: string; line: number; at?: () => { x: number; y: number } | undefined; place?: () => Place | undefined; selected?: () => string };

/** Where an editor's cursor is: its line and column (0-based) and, while in view, how far its line is from the top (px). */
export type Place = { line: number; col: number; top?: number };

export function placeOf(ed: Monaco.editor.ICodeEditor): Place | undefined {
  const pos = ed.getPosition();
  if (!pos) return undefined;
  const top = ed.getTopForLineNumber(pos.lineNumber) - ed.getScrollTop();
  return { line: pos.lineNumber - 1, col: pos.column - 1, top: top >= 0 && top < ed.getLayoutInfo().height ? top : undefined };
}

/** Puts an editor's cursor at place, its line as far from the top as it was (centered if it wasn't in view). */
export function goTo(ed: Monaco.editor.ICodeEditor, place: Place) {
  const pos = { lineNumber: place.line + 1, column: place.col + 1 };
  ed.setPosition(pos);
  if (place.top === undefined) ed.revealPositionInCenter(pos);
  else ed.setScrollTop(ed.getTopForLineNumber(pos.lineNumber) - place.top);
}

/** Where an editor's cursor is on screen: the bottom left of its line (undefined while scrolled out of view). */
export function cursorPoint(ed: Monaco.editor.ICodeEditor): { x: number; y: number } | undefined {
  const pos = ed.getPosition();
  const dom = ed.getDomNode();
  const vis = pos && ed.getScrolledVisiblePosition(pos);
  if (!dom || !vis) return undefined;
  const box = dom.getBoundingClientRect();
  if (vis.top < 0 || vis.top + vis.height > box.height) return undefined;
  return { x: box.left + vis.left, y: box.top + vis.top + vis.height };
}
export const cursors = new Map<string, Cursor>();
export function cursorOf(paneId: string): Cursor {
  let c = cursors.get(paneId);
  if (!c) cursors.set(paneId, (c = { line: 0 }));
  return c;
}

/**
 * Per viewer slot, its diff viewer: which change the cursor is at (1-based,
 * 0 before the first) of how many, and how to move (j/k, header buttons).
 */
export type DiffNavState = { index: number; total: number; go?: (target: "next" | "previous") => void };
export const useDiffNav = create<Record<string, DiffNavState>>(() => ({}));
const noNav: DiffNavState = { index: 0, total: 0 };
export const diffNavOf = (slot: string) => useDiffNav.getState()[slot] ?? noNav;
export const useDiffNavOf = (slot: string) => useDiffNav((s) => s[slot] ?? noNav);
const setNav = (slot: string, n: DiffNavState | undefined) =>
  useDiffNav.setState((s) => {
    const { [slot]: _, ...rest } = s;
    return n ? { ...rest, [slot]: n } : rest;
  }, true);

/** Per viewer slot, its loaded diff's place in the object's history, for [ / ] (set by the object view). */
export type DiffRange = { to: number; first: number; last: number };
export const useDiffRange = create<Record<string, DiffRange>>(() => ({}));
export const setDiffRange = (slot: string, r: DiffRange | undefined) =>
  useDiffRange.setState((s) => {
    const { [slot]: _, ...rest } = s;
    return r ? { ...rest, [slot]: r } : rest;
  }, true);

/** The slot of what a pane's object view shows now: a decoded value over the object, or the object. */
export const viewSlot = (paneId: string, decoding: boolean) => (decoding ? `${paneId}/decode` : paneId);

/** An entry of the editor's right-click menu (on the line clicked: Monaco moves the cursor there first). */
export interface ContextAction {
  id: string;
  label: string;
  /** Shown with the label, e.g. "⇧H" (Monaco's own keybinding display would intercept the key). */
  key?: string;
  run: () => void;
}

interface Props {
  /** Shown text; with `original` the viewer is a side-by-side diff (original → value). */
  value: string;
  original?: string;
  language?: "yaml" | "json" | "plaintext";
  label: string;
  /**
   * Whose cursor (YAML or JSON only) and diff navigation it has: a pane's object
   * viewer (the pane id), or what's shown in its place ("<pane>/decode",
   * "<pane>/edit"), so the object's stays as it was under them.
   */
  slot: string;
  /** Takes the keyboard focus on mount (the pane is the focused one). */
  autoFocus?: boolean;
  /** Extra right-click entries (the diff: on its right side). */
  contextActions?: ContextAction[];
  /** A click into it: the pane gets the focus. */
  onFocus?: () => void;
  /**
   * The single viewer's cursor and scroll position, kept across remounts:
   * restored from `state` when it opens, saved into it when it closes (a
   * decode's level, back from a deeper one).
   */
  viewState?: ViewState;
  /** An object's YAML (the diff: its right side): its references are marked, ⌘-click jumps to one (see useFieldRefs). */
  refs?: FieldRefs;
  /** The object's YAML (single viewer only): while blame is on (b), each line's field manager in the gutter. */
  blame?: BlameOf;
  /** What the blame found: no managedFields, or why it failed. */
  onBlame?: (s: BlameState) => void;
}

/** What marks an object's references: the pane (Go matches the rules for its kind) and where a ⌘-click goes. */
export interface FieldRefs {
  serverId: string;
  /** ⌘-click on the reference at line (0-based) of text; split: ⇧ was held too. */
  jump: (text: string, line: number, split: boolean) => void;
}

/**
 * Marks the reference values of an object's YAML in an editor (asked from
 * Go for each text shown) and makes them ⌘-clickable: the pointer turns
 * into a hand over one while ⌘ is held. Returns the disposer.
 */
export function markRefs(m: MonacoApi, ed: Monaco.editor.ICodeEditor, refs: FieldRefs): { update: (text: string) => void; dispose: () => void } {
  const marks = ed.createDecorationsCollection();
  let gen = 0;
  let ranges: Monaco.Range[] = [];
  const update = (text: string) => {
    const g = ++gen;
    void bridge()
      .fieldRefs(refs.serverId, text)
      .then(
        (list) => {
          if (g !== gen) return;
          ranges = list.map((r) => new m.Range(r.line + 1, r.col, r.line + 1, r.endCol));
          marks.set(list.map((r, i) => ({ range: ranges[i]!, options: { inlineClassName: "kw-ref", hoverMessage: { value: `${r.label} — ⌘-click: jump · ⇧⌘-click: split · ⌘J: menu` } } })));
        },
        // text that doesn't parse (the editor mid-typing): the old marks would be in the wrong places
        () => g === gen && ((ranges = []), marks.clear()),
      );
  };
  const at = (p: Monaco.Position | null | undefined) => (p ? ranges.find((r) => r.containsPosition(p)) : undefined);
  const subs = [
    ed.onMouseDown((e) => {
      const r = (e.event.metaKey || e.event.ctrlKey) && at(e.target.position);
      if (!r) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      refs.jump(ed.getModel()?.getValue() ?? "", r.startLineNumber - 1, e.event.shiftKey);
    }),
    ed.onMouseMove((e) => ed.getDomNode()?.classList.toggle("kw-ref-hand", (e.event.metaKey || e.event.ctrlKey) && !!at(e.target.position))),
    ed.onMouseLeave(() => ed.getDomNode()?.classList.remove("kw-ref-hand")),
  ];
  return {
    update,
    dispose: () => {
      gen++;
      subs.forEach((d) => d.dispose());
      marks.clear();
    },
  };
}

/** A viewer's cursor and scroll position (see Props.viewState). */
export type ViewState = { state?: Monaco.editor.ICodeEditorViewState | Monaco.editor.IDiffEditorViewState | null };

export function addActions(ed: Monaco.editor.IStandaloneCodeEditor, actions: ContextAction[] | undefined) {
  return (actions ?? []).map((a, i) =>
    ed.addAction({ id: a.id, label: a.key ? `${a.label} (${a.key})` : a.label, contextMenuGroupId: "kubewing", contextMenuOrder: i, run: a.run }),
  );
}

/**
 * Read-only Monaco viewer (YAML/JSON/text) or diff viewer of a pane's object
 * view. A new text in the same mode swaps the models: cursor and scroll
 * stay (a newer version, a followed row of the same shape).
 */
export function Viewer({ value, original, language = "yaml", label, slot, autoFocus, contextActions, onFocus, viewState, refs, blame, onBlame }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const themeGen = useConfig((s) => s.themeGen);
  const mode = original === undefined ? "single" : "diff";
  const wrap = useUI((s) => s.wrap);
  // a cursor for line commands: YAML, or JSON (YAML reads it too: a decoded value's ⏎ deeper)
  const fields = language !== "plaintext";
  const editor = useRef<{ updateOptions(o: Monaco.editor.IEditorOptions): void; focus(): void }>(undefined);
  // the latest callbacks and texts, for the editor created once per mode
  const live = useRef({ onFocus, value, original, refs, onBlame });
  live.current = { onFocus, value, original, refs, onBlame };
  const blaming = useUI((s) => !!s.blame) && !!blame && original === undefined;
  // the single viewer's editor and its text, for the blame toggled on and off without a new editor
  const single = useRef<Monaco.editor.ICodeEditor>(undefined);
  const blamed = useRef<ReturnType<typeof showBlame>>(undefined);
  // the latest pane and jump for the marks of the editor created once per mode
  const liveRefs: FieldRefs | undefined = refs && { serverId: refs.serverId, jump: (t, l, sp) => live.current.refs?.jump(t, l, sp) };
  const swap = useRef<(value: string, original?: string) => void>(undefined);
  // wordWrapOverride1, not wordWrap: with accessibility support on, Monaco forces wrapping
  // for text dominated by long lines unless the override says otherwise
  const wordWrap = (on: boolean): Monaco.editor.IEditorOptions => ({ wordWrap: on ? "on" : "off", wordWrapOverride1: on ? "on" : "off", wrappingIndent: "indent" });

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    const cur = cursorOf(slot);
    void loadMonaco().then((m) => {
      if (disposed || !host.current) return;
      defineTheme(m);
      if (mode === "single") {
        let model = m.editor.createModel(live.current.value, language);
        const ed = m.editor.create(host.current, { ...common, ...fontOptions(), ...wordWrap(useUI.getState().wrap), model, ariaLabel: label });
        editor.current = ed;
        single.current = ed;
        if (viewState?.state) ed.restoreViewState(viewState.state as Monaco.editor.ICodeEditorViewState);
        if (autoFocus) ed.focus();
        if (fields) {
          cur.text = live.current.value;
          cur.line = (ed.getPosition()?.lineNumber ?? 1) - 1;
          cur.at = () => cursorPoint(ed);
          cur.place = () => placeOf(ed);
          cur.selected = () => ed.getModel()?.getValueInRange(ed.getSelection()!) ?? "";
        }
        const subs = [
          ed.onDidChangeCursorPosition((e) => {
            if (fields) cur.line = e.position.lineNumber - 1;
          }),
          ed.onDidFocusEditorText(() => live.current.onFocus?.()),
        ];
        swap.current = (value) => {
          const view = ed.saveViewState();
          const old = model;
          model = m.editor.createModel(value, language);
          ed.setModel(model);
          if (view) ed.restoreViewState(view);
          old.dispose();
          if (fields) cur.text = value;
        };
        const acts = addActions(ed, contextActions);
        const marked = liveRefs && markRefs(m, ed, liveRefs);
        marked?.update(live.current.value);
        const swapped = swap.current;
        swap.current = (value) => {
          swapped(value);
          marked?.update(value);
          blamed.current?.update(value);
        };
        setBlaming.current?.();
        dispose = () => {
          marked?.dispose();
          blamed.current?.dispose();
          blamed.current = single.current = undefined;
          if (viewState) viewState.state = ed.saveViewState();
          if (cur.text === model.getValue()) cur.text = cur.at = cur.place = cur.selected = undefined;
          acts.forEach((a) => a.dispose());
          subs.forEach((d) => d.dispose());
          ed.dispose();
          model.dispose();
        };
      } else {
        let a = m.editor.createModel(live.current.original ?? "", language);
        let b = m.editor.createModel(live.current.value, language);
        // diffWordWrap follows wordWrap ("inherit")
        const ed = m.editor.createDiffEditor(host.current, { ...common, ...fontOptions(), ...wordWrap(useUI.getState().wrap), renderSideBySide: true, originalEditable: false, ariaLabel: label });
        editor.current = { updateOptions: (o) => ed.updateOptions(o), focus: () => ed.getModifiedEditor().focus() };
        ed.setModel({ original: a, modified: b });
        const mod = ed.getModifiedEditor();
        if (viewState?.state) ed.restoreViewState(viewState.state as Monaco.editor.IDiffEditorViewState);
        if (autoFocus) mod.focus();
        // the right side's cursor line, for "the field at the cursor" (⇧H) in the diff
        if (fields) {
          cur.text = live.current.value;
          cur.line = 0;
          cur.at = () => cursorPoint(mod);
          cur.place = () => placeOf(mod);
        }
        const acts = addActions(mod, contextActions);
        // first line of each change on the modified side (a pure deletion: the line after it)
        const starts = () => (ed.getLineChanges() ?? []).map((c) => c.modifiedStartLineNumber || c.modifiedEndLineNumber + 1);
        const go = (t: "next" | "previous") => ed.goToDiff(t);
        const sync = () => {
          const s = starts();
          setNav(slot, { total: s.length, index: changeIndex(s, mod.getPosition()?.lineNumber ?? 1), go });
        };
        let first = true;
        const subs = [
          ed.onDidUpdateDiff(() => {
            // the diff is computed async: land on the first change once it's there (unless it's back where it was)
            if (first && starts().length && !viewState?.state) ed.goToDiff("next");
            first = false;
            sync();
          }),
          mod.onDidChangeCursorPosition((e) => {
            if (fields) cur.line = e.position.lineNumber - 1;
            sync();
          }),
          mod.onDidFocusEditorText(() => live.current.onFocus?.()),
          ed.getOriginalEditor().onDidFocusEditorText(() => live.current.onFocus?.()),
        ];
        swap.current = (value, original) => {
          // one diff editor across versions: the models are swapped, the scroll position stays
          const [oa, ob] = [a, b];
          a = m.editor.createModel(original ?? "", language);
          b = m.editor.createModel(value, language);
          ed.setModel({ original: a, modified: b });
          oa.dispose();
          ob.dispose();
          if (fields) cur.text = value;
        };
        setNav(slot, { index: 0, total: 0, go });
        const marked = liveRefs && markRefs(m, mod, liveRefs);
        marked?.update(live.current.value);
        const swapped = swap.current;
        if (marked)
          swap.current = (value, original) => {
            swapped(value, original);
            marked.update(value);
          };
        dispose = () => {
          marked?.dispose();
          if (viewState) viewState.state = ed.saveViewState();
          if (cur.text === b.getValue()) cur.text = cur.at = cur.place = cur.selected = undefined;
          acts.forEach((x) => x.dispose());
          subs.forEach((d) => d.dispose());
          setNav(slot, undefined);
          ed.dispose();
          a.dispose();
          b.dispose();
        };
      }
    });
    return () => {
      disposed = true;
      editor.current = undefined;
      swap.current = undefined;
      dispose();
    };
  }, [slot, language, mode, contextActions?.map((a) => a.id).join(), refs?.serverId]);

  // another text in the same viewer: its models swapped (the first is the one it was created with)
  const shown = useRef({ value, original });
  useEffect(() => {
    if (shown.current.value === value && shown.current.original === original) return;
    shown.current = { value, original };
    swap.current?.(value, original);
  }, [value, original]);

  // the pane focused again (a click on its header, ⌘⌥arrows): the keys go to the viewer
  // and while it should have them, the dock gives them back after a layout change took them (see focus.ts)
  useEffect(() => {
    if (!autoFocus) return;
    editor.current?.focus();
    return claimFocus(() => editor.current?.focus());
  }, [autoFocus]);

  // toggling wrap keeps the editor (cursor, scroll position)
  useEffect(() => editor.current?.updateOptions(wordWrap(wrap)), [wrap]);

  // blame on / off (b), and for another row: the gutter of the same editor
  const setBlaming = useRef<() => void>(undefined);
  setBlaming.current = () => {
    const ed = single.current;
    blamed.current?.dispose();
    blamed.current = undefined;
    if (!ed || !blaming || !blame) return live.current.onBlame?.({});
    blamed.current = showBlame(ed, blame, (st) => live.current.onBlame?.(st));
    blamed.current.update(ed.getModel()?.getValue() ?? "");
  };
  useEffect(() => setBlaming.current?.(), [blaming, blame?.serverId, blame?.key]);

  useEffect(() => {
    if (themeGen)
      void loadMonaco().then((m) => {
        defineTheme(m);
        if (editor.current) updateFont(m, editor.current);
      });
  }, [themeGen]);

  return <div ref={host} data-viewer={mode} data-wrap={wrap} className="h-full w-full" />;
}
