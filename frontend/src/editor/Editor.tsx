import { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { useConfig } from "../store/config";
import { useUI } from "../store/store";
import { showBlame, type BlameOf, type BlameState } from "./blame";
import { changedRange } from "./changed";
import { claimFocus } from "./focus";
import { loadMonaco } from "./load";
import { addActions, common, cursorOf, cursorPoint, defineTheme, fontOptions, goTo, markRefs, type ContextAction, type FieldRefs, type Place, updateFont, type ViewState } from "./Viewer";

interface Props {
  /** The text it opens with; later changes of the prop don't reset what was typed. */
  initial: string;
  /**
   * The text set from outside (a decoded level encoded back into it): when it
   * changes and differs from the editor's, it's applied as one edit (⌘Z takes
   * it back), only the lines that differ replaced.
   */
  value?: string;
  /** The language of the text (YAML unless set). */
  language?: "yaml" | "json" | "plaintext";
  onChange: (text: string) => void;
  /** ⌘⏎ in the editor (⏎ is a newline here). */
  onSubmit?: () => void;
  /** ⌘S in the editor. */
  onSave?: () => void;
  label: string;
  /** Takes the keyboard focus on mount, and again when it becomes true (its pane focused again). */
  autoFocus?: boolean;
  /** A click into it. */
  onFocus?: () => void;
  /** Whose cursor it has (the text as typed and the cursor line), for commands on the field at the cursor (⌘J). */
  slot?: string;
  /** An object's YAML: its references marked as typed, ⌘-clickable. */
  refs?: FieldRefs;
  /** Where the cursor starts (the line the YAML viewer's cursor was on). */
  at?: Place;
  /** The cursor and scroll position, kept across remounts (back from the edit's preview): restored when it opens, saved when it closes. */
  viewState?: ViewState;
  /** The object edited: while blame is on (⌘B), each line's field manager in the gutter, following the text as typed. */
  blame?: BlameOf;
  /** What the blame found: no managedFields, or why the text can't be blamed (it doesn't parse). */
  onBlame?: (s: BlameState) => void;
  /** Right-click menu entries (set when it opens). */
  contextActions?: ContextAction[];
}

/**
 * Editable YAML in Monaco (the ops pod dialog's "show YAML"), themed like
 * the read-only Viewer. Esc reaches the dialog (closes the YAML), unless
 * Monaco's find widget is open. ⌘D deletes the line (Monaco's own ⌘⇧K too),
 * ⌥↑/⌥↓ move it, ⌘/ comments it in or out.
 */
export function Editor({ initial, value, language = "yaml", onChange, onSubmit, onSave, label, autoFocus = true, onFocus, slot, refs, at, viewState, blame, onBlame, contextActions }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const themeGen = useConfig((s) => s.themeGen);
  const cb = useRef({ onChange, onSubmit, onSave, onFocus, refs, onBlame });
  cb.current = { onChange, onSubmit, onSave, onFocus, refs, onBlame };
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor>(undefined);
  const blaming = useUI((s) => !!s.blame) && !!blame;
  const blamed = useRef<ReturnType<typeof showBlame>>(undefined);
  const setBlaming = useRef<() => void>(undefined);
  setBlaming.current = () => {
    const ed = editor.current;
    blamed.current?.dispose();
    blamed.current = undefined;
    if (!ed || !blaming || !blame) return cb.current.onBlame?.({});
    blamed.current = showBlame(ed, blame, (st) => cb.current.onBlame?.(st));
    blamed.current.update(ed.getModel()?.getValue() ?? "");
  };

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    void loadMonaco().then((m) => {
      if (disposed || !host.current) return;
      defineTheme(m);
      const model = m.editor.createModel(initial, language);
      const ed = m.editor.create(host.current, { ...common, ...fontOptions(), readOnly: false, domReadOnly: false, renderLineHighlight: "line", stickyScroll: { enabled: false }, tabSize: 2, model, ariaLabel: label });
      editor.current = ed;
      if (viewState?.state) ed.restoreViewState(viewState.state as Monaco.editor.ICodeEditorViewState);
      else if (at) goTo(ed, at);
      if (autoFocus) ed.focus();
      const cur = slot ? cursorOf(slot) : undefined;
      if (cur) {
        cur.text = initial;
        cur.line = (ed.getPosition()?.lineNumber ?? 1) - 1;
        cur.at = () => cursorPoint(ed);
      }
      // the marks follow the text as typed, a moment after the last key
      const marked = refs && markRefs(m, ed, { serverId: refs.serverId, jump: (t, l, sp) => cb.current.refs?.jump(t, l, sp) });
      marked?.update(initial);
      let typing: ReturnType<typeof setTimeout> | undefined;
      const sub = model.onDidChangeContent(() => {
        const text = model.getValue();
        if (cur) cur.text = text;
        cb.current.onChange(text);
        clearTimeout(typing);
        typing = setTimeout(() => {
          marked?.update(text);
          blamed.current?.update(text);
        }, 300);
      });
      const cursorSub = ed.onDidChangeCursorPosition((e) => {
        if (cur) cur.line = e.position.lineNumber - 1;
      });
      const focusSub = ed.onDidFocusEditorText(() => cb.current.onFocus?.());
      ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => cb.current.onSubmit?.());
      // only where there's something to save: elsewhere ⌘S stays the app's (the object editor's apply)
      if (onSave) ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => cb.current.onSave?.());
      ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyD, () => ed.trigger("keyboard", "editor.action.deleteLines", null));
      setBlaming.current?.();
      const acts = addActions(ed, contextActions);
      dispose = () => {
        for (const a of acts) a.dispose();
        blamed.current?.dispose();
        blamed.current = undefined;
        if (viewState) viewState.state = ed.saveViewState();
        clearTimeout(typing);
        marked?.dispose();
        if (cur && cur.text === model.getValue()) cur.text = cur.at = undefined;
        cursorSub.dispose();
        sub.dispose();
        focusSub.dispose();
        ed.dispose();
        model.dispose();
      };
    });
    return () => {
      disposed = true;
      editor.current = undefined;
      dispose();
    };
  }, []);

  // and while it should have them, the dock gives them back after a layout change took them (see focus.ts)
  useEffect(() => {
    if (!autoFocus) return;
    editor.current?.focus();
    return claimFocus(() => editor.current?.focus());
  }, [autoFocus]);

  useEffect(() => setBlaming.current?.(), [blaming, blame?.serverId, blame?.key]);

  useEffect(() => {
    const model = editor.current?.getModel();
    if (value === undefined || !model) return;
    const now = model.getValue();
    if (now === value) return;
    const r = changedRange(now, value);
    const ed = editor.current!;
    ed.pushUndoStop();
    ed.executeEdits("kubewing", [{ range: { startLineNumber: r.from + 1, startColumn: 1, endLineNumber: r.to + 1, endColumn: model.getLineMaxColumn(r.to + 1) }, text: r.text }]);
    ed.pushUndoStop();
  }, [value]);

  useEffect(() => {
    if (themeGen)
      void loadMonaco().then((m) => {
        defineTheme(m);
        if (editor.current) updateFont(m, editor.current);
      });
  }, [themeGen]);

  return <div ref={host} data-editor="yaml" className="h-full w-full" />;
}

