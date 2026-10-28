import { useEffect, useRef } from "react";
import { create } from "zustand";
import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { useConfig } from "../store/config";
import { useUI } from "../store/store";
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

export const common: Monaco.editor.IEditorOptions = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  fontFamily: getComputedStyle(document.body).fontFamily,
  fontSize: 12,
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
export type Cursor = { text?: string; line: number };
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
  language?: "yaml" | "plaintext";
  label: string;
  /**
   * Whose cursor (YAML only) and diff navigation it has: a pane's object
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
}

/** A viewer's cursor and scroll position (see Props.viewState). */
export type ViewState = { state?: Monaco.editor.ICodeEditorViewState | Monaco.editor.IDiffEditorViewState | null };

function addActions(ed: Monaco.editor.IStandaloneCodeEditor, actions: ContextAction[] | undefined) {
  return (actions ?? []).map((a, i) =>
    ed.addAction({ id: a.id, label: a.key ? `${a.label} (${a.key})` : a.label, contextMenuGroupId: "kubewing", contextMenuOrder: i, run: a.run }),
  );
}

/**
 * Read-only Monaco viewer (YAML/text) or diff viewer of a pane's object
 * view. A new text in the same mode swaps the models: cursor and scroll
 * stay (a newer version, a followed row of the same shape).
 */
export function Viewer({ value, original, language = "yaml", label, slot, autoFocus, contextActions, onFocus, viewState }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const themeGen = useConfig((s) => s.themeGen);
  const mode = original === undefined ? "single" : "diff";
  const wrap = useUI((s) => s.wrap);
  const editor = useRef<{ updateOptions(o: Monaco.editor.IEditorOptions): void; focus(): void }>(undefined);
  // the latest callbacks and texts, for the editor created once per mode
  const live = useRef({ onFocus, value, original });
  live.current = { onFocus, value, original };
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
        const ed = m.editor.create(host.current, { ...common, ...wordWrap(useUI.getState().wrap), model, ariaLabel: label });
        editor.current = ed;
        if (viewState?.state) ed.restoreViewState(viewState.state as Monaco.editor.ICodeEditorViewState);
        if (autoFocus) ed.focus();
        if (language === "yaml") {
          cur.text = live.current.value;
          cur.line = (ed.getPosition()?.lineNumber ?? 1) - 1;
        }
        const subs = [
          ed.onDidChangeCursorPosition((e) => {
            if (language === "yaml") cur.line = e.position.lineNumber - 1;
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
          if (language === "yaml") cur.text = value;
        };
        const acts = addActions(ed, contextActions);
        dispose = () => {
          if (viewState) viewState.state = ed.saveViewState();
          if (cur.text === model.getValue()) cur.text = undefined;
          acts.forEach((a) => a.dispose());
          subs.forEach((d) => d.dispose());
          ed.dispose();
          model.dispose();
        };
      } else {
        let a = m.editor.createModel(live.current.original ?? "", language);
        let b = m.editor.createModel(live.current.value, language);
        // diffWordWrap follows wordWrap ("inherit")
        const ed = m.editor.createDiffEditor(host.current, { ...common, ...wordWrap(useUI.getState().wrap), renderSideBySide: true, originalEditable: false, ariaLabel: label });
        editor.current = { updateOptions: (o) => ed.updateOptions(o), focus: () => ed.getModifiedEditor().focus() };
        ed.setModel({ original: a, modified: b });
        const mod = ed.getModifiedEditor();
        if (viewState?.state) ed.restoreViewState(viewState.state as Monaco.editor.IDiffEditorViewState);
        if (autoFocus) mod.focus();
        // the right side's cursor line, for "the field at the cursor" (⇧H) in the diff
        if (language === "yaml") {
          cur.text = live.current.value;
          cur.line = 0;
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
            if (language === "yaml") cur.line = e.position.lineNumber - 1;
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
          if (language === "yaml") cur.text = value;
        };
        setNav(slot, { index: 0, total: 0, go });
        dispose = () => {
          if (viewState) viewState.state = ed.saveViewState();
          if (cur.text === b.getValue()) cur.text = undefined;
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
  }, [slot, language, mode, contextActions?.map((a) => a.id).join()]);

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

  useEffect(() => {
    if (themeGen) void loadMonaco().then(defineTheme);
  }, [themeGen]);

  return <div ref={host} data-viewer={mode} data-wrap={wrap} className="h-full w-full" />;
}
