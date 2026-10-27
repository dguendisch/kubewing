import { useEffect, useRef } from "react";
import { useConfig } from "../store/config";
import { loadMonaco } from "./load";
import { common, defineTheme } from "./Viewer";

interface Props {
  /** The text it opens with; later changes of the prop don't reset what was typed. */
  initial: string;
  onChange: (text: string) => void;
  /** ⌘⏎ in the editor (⏎ is a newline here). */
  onSubmit?: () => void;
  label: string;
}

/**
 * Editable YAML in Monaco (the ops pod dialog's "show YAML"), themed like
 * the read-only Viewer. Esc reaches the dialog (closes the YAML), unless
 * Monaco's find widget is open. ⌘D deletes the line (Monaco's own ⌘⇧K too),
 * ⌥↑/⌥↓ move it.
 */
export function Editor({ initial, onChange, onSubmit, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const themeGen = useConfig((s) => s.themeGen);
  const cb = useRef({ onChange, onSubmit });
  cb.current = { onChange, onSubmit };

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    void loadMonaco().then((m) => {
      if (disposed || !host.current) return;
      defineTheme(m);
      const model = m.editor.createModel(initial, "yaml");
      const ed = m.editor.create(host.current, { ...common, readOnly: false, domReadOnly: false, renderLineHighlight: "line", stickyScroll: { enabled: false }, tabSize: 2, model, ariaLabel: label });
      ed.focus();
      const sub = model.onDidChangeContent(() => cb.current.onChange(model.getValue()));
      ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => cb.current.onSubmit?.());
      ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyD, () => ed.trigger("keyboard", "editor.action.deleteLines", null));
      dispose = () => {
        sub.dispose();
        ed.dispose();
        model.dispose();
      };
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (themeGen) void loadMonaco().then(defineTheme);
  }, [themeGen]);

  return <div ref={host} data-editor="yaml" className="h-full w-full" />;
}
