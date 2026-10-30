import { useEffect, useRef } from "react";
import { useConfig } from "../store/config";
import { claimFocus } from "./focus";
import { loadMonaco } from "./load";
import { common, cursorOf, cursorPoint, defineTheme, markRefs, type FieldRefs } from "./Viewer";

interface Props {
  /** The text it opens with; later changes of the prop don't reset what was typed. */
  initial: string;
  onChange: (text: string) => void;
  /** ⌘⏎ in the editor (⏎ is a newline here). */
  onSubmit?: () => void;
  label: string;
  /** Takes the keyboard focus on mount, and again when it becomes true (its pane focused again). */
  autoFocus?: boolean;
  /** A click into it. */
  onFocus?: () => void;
  /** Whose cursor it has (the text as typed and the cursor line), for commands on the field at the cursor (⌘J). */
  slot?: string;
  /** An object's YAML: its references marked as typed, ⌘-clickable. */
  refs?: FieldRefs;
}

/**
 * Editable YAML in Monaco (the ops pod dialog's "show YAML"), themed like
 * the read-only Viewer. Esc reaches the dialog (closes the YAML), unless
 * Monaco's find widget is open. ⌘D deletes the line (Monaco's own ⌘⇧K too),
 * ⌥↑/⌥↓ move it.
 */
export function Editor({ initial, onChange, onSubmit, label, autoFocus = true, onFocus, slot, refs }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const themeGen = useConfig((s) => s.themeGen);
  const cb = useRef({ onChange, onSubmit, onFocus, refs });
  cb.current = { onChange, onSubmit, onFocus, refs };
  const editor = useRef<{ focus(): void }>(undefined);

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    void loadMonaco().then((m) => {
      if (disposed || !host.current) return;
      defineTheme(m);
      const model = m.editor.createModel(initial, "yaml");
      const ed = m.editor.create(host.current, { ...common, readOnly: false, domReadOnly: false, renderLineHighlight: "line", stickyScroll: { enabled: false }, tabSize: 2, model, ariaLabel: label });
      editor.current = ed;
      if (autoFocus) ed.focus();
      const cur = slot ? cursorOf(slot) : undefined;
      if (cur) {
        cur.text = initial;
        cur.line = 0;
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
        if (marked) typing = setTimeout(() => marked.update(text), 300);
      });
      const cursorSub = ed.onDidChangeCursorPosition((e) => {
        if (cur) cur.line = e.position.lineNumber - 1;
      });
      const focusSub = ed.onDidFocusEditorText(() => cb.current.onFocus?.());
      ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => cb.current.onSubmit?.());
      ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyD, () => ed.trigger("keyboard", "editor.action.deleteLines", null));
      dispose = () => {
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

  useEffect(() => {
    if (themeGen) void loadMonaco().then(defineTheme);
  }, [themeGen]);

  return <div ref={host} data-editor="yaml" className="h-full w-full" />;
}
