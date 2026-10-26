import { useEffect, useRef } from "react";
import { create } from "zustand";
import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { useConfig } from "../store/config";
import { useUI } from "../store/store";
import { changeIndex } from "./diffnav";
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
 * The YAML viewer currently shown and its cursor line (0-based), for
 * commands that act on "the line under the cursor" (= / ! filters).
 */
export const cursor: { text?: string; line: number } = { line: 0 };

/**
 * The diff editor currently shown: which change the cursor is at (1-based,
 * 0 before the first) of how many, and how to move (j/k, header buttons).
 */
export const useDiffNav = create<{ index: number; total: number; go?: (target: "next" | "previous") => void }>(() => ({ index: 0, total: 0 }));

/** The open object diff's place in the object's history, for [ / ] (set by the detail view). */
export const useDiffRange = create<{ range?: { to: number; first: number; last: number } }>(() => ({}));

interface Props {
  /** Shown text; with `original` the viewer is a side-by-side diff (original → value). */
  value: string;
  original?: string;
  language?: "yaml" | "plaintext";
  label: string;
}

/** Read-only Monaco viewer (YAML/text) or diff viewer; focuses itself on mount. */
export function Viewer({ value, original, language = "yaml", label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const themeGen = useConfig((s) => s.themeGen);
  const mode = original === undefined ? "single" : "diff";
  const wrap = useUI((s) => s.wrap);
  const editor = useRef<{ updateOptions(o: Monaco.editor.IEditorOptions): void }>(undefined);
  // wordWrapOverride1, not wordWrap: with accessibility support on, Monaco forces wrapping
  // for text dominated by long lines unless the override says otherwise
  const wordWrap = (on: boolean): Monaco.editor.IEditorOptions => ({ wordWrap: on ? "on" : "off", wordWrapOverride1: on ? "on" : "off", wrappingIndent: "indent" });

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    void loadMonaco().then((m) => {
      if (disposed || !host.current) return;
      defineTheme(m);
      if (original === undefined) {
        const model = m.editor.createModel(value, language);
        const ed = m.editor.create(host.current, { ...common, ...wordWrap(useUI.getState().wrap), model, ariaLabel: label });
        editor.current = ed;
        ed.focus();
        if (language === "yaml") {
          cursor.text = value;
          cursor.line = 0;
          ed.onDidChangeCursorPosition((e) => (cursor.line = e.position.lineNumber - 1));
        }
        dispose = () => {
          if (cursor.text === value) cursor.text = undefined;
          ed.dispose();
          model.dispose();
        };
      } else {
        const a = m.editor.createModel(original, language);
        const b = m.editor.createModel(value, language);
        // diffWordWrap follows wordWrap ("inherit")
        const ed = m.editor.createDiffEditor(host.current, { ...common, ...wordWrap(useUI.getState().wrap), renderSideBySide: true, originalEditable: false, ariaLabel: label });
        editor.current = ed;
        ed.setModel({ original: a, modified: b });
        const mod = ed.getModifiedEditor();
        mod.focus();
        // first line of each change on the modified side (a pure deletion: the line after it)
        const starts = () => (ed.getLineChanges() ?? []).map((c) => c.modifiedStartLineNumber || c.modifiedEndLineNumber + 1);
        const sync = () => {
          const s = starts();
          useDiffNav.setState({ total: s.length, index: changeIndex(s, mod.getPosition()?.lineNumber ?? 1) });
        };
        let first = true;
        const subs = [
          ed.onDidUpdateDiff(() => {
            // the diff is computed async: land on the first change once it's there
            if (first && starts().length) ed.goToDiff("next");
            first = false;
            sync();
          }),
          mod.onDidChangeCursorPosition(sync),
        ];
        useDiffNav.setState({ index: 0, total: 0, go: (t) => ed.goToDiff(t) });
        dispose = () => {
          subs.forEach((d) => d.dispose());
          useDiffNav.setState({ index: 0, total: 0, go: undefined });
          ed.dispose();
          a.dispose();
          b.dispose();
        };
      }
    });
    return () => {
      disposed = true;
      editor.current = undefined;
      dispose();
    };
  }, [value, original, language, mode]);

  // toggling wrap keeps the editor (cursor, scroll position)
  useEffect(() => editor.current?.updateOptions(wordWrap(wrap)), [wrap]);

  useEffect(() => {
    if (themeGen) void loadMonaco().then(defineTheme);
  }, [themeGen]);

  return <div ref={host} data-viewer={mode} data-wrap={wrap} className="h-full w-full" />;
}
