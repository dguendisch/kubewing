import { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { useConfig } from "../store/config";
import { useUI } from "../store/store";
import { loadMonaco, type MonacoApi } from "./load";

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();

/** Monaco theme from the CSS theme tokens (Monaco can't read CSS variables). */
function defineTheme(m: MonacoApi) {
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

const common: Monaco.editor.IEditorOptions = {
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
        ed.getModifiedEditor().focus();
        dispose = () => (ed.dispose(), a.dispose(), b.dispose());
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
