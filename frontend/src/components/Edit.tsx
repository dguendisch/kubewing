import { Editor } from "../editor/Editor";
import { Viewer } from "../editor/Viewer";
import { useRules } from "../store/rules";
import { setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { DiffNav } from "./Detail";
import { ruleColor } from "./safetyStyle";

/**
 * Edit overlay (e, as kubectl edit): the object's YAML in the editor; ⌘S
 * dry-runs it on the server and shows what would change, ⏎ there writes it.
 * Framed in the context's color, like the pane it came from.
 */
export function Edit() {
  const o = useUI((s) => (s.overlay?.kind === "edit" ? s.overlay : undefined));
  const context = useUI((s) => (o ? s.panes[o.pane]?.context : undefined));
  const rule = useRules((r) => (context ? r[context] : undefined));
  const e = o?.edit;
  if (!e) return null;
  const color = ruleColor(rule);
  const preview = e.preview;
  return (
    <div
      role="dialog"
      aria-label="edit object"
      className="absolute inset-6 z-20 flex flex-col border bg-bg-elev shadow-2xl"
      style={{ borderColor: color ?? "var(--color-accent)" }}
    >
      <div className="flex gap-3 border-b border-border px-3 py-1 text-fg-muted">
        {rule?.label ? (
          <span className="px-1 font-semibold text-bg" style={{ background: color ?? "var(--color-accent)" }}>
            {rule.label}
          </span>
        ) : null}
        <span className="text-fg">{e.title}</span>
        <span>{preview ? "preview (server dry run: current → after the edit)" : e.yaml !== e.opened ? "edit (changed)" : "edit"}</span>
        {preview ? <DiffNav /> : null}
        <span className="ml-auto">{preview ? "⏎ / ⌘⏎: apply · j/k: changes · w: wrap · esc: back to editing" : "⌘S / ⌘⏎: preview · esc: close"}</span>
      </div>
      <div className="min-h-0 flex-1">
        {preview ? (
          <Viewer key="edit-preview" label="edit preview" original={preview.prevNorm} value={preview.curNorm} />
        ) : (
          // the key remounts the editor with the current text when it comes back from the preview
          <Editor
            key={`edit-${e.session}`}
            label="edit YAML"
            initial={e.yaml}
            onChange={(yaml) => setUI((x) => S.setEdit(x, (d) => ({ ...d, yaml, discarding: false })))}
          />
        )}
      </div>
      {e.discarding ? (
        <div role="status" className="border-t border-border px-3 py-1 text-changed">
          unsaved changes: esc again discards them
        </div>
      ) : e.error ? (
        <div role="alert" className="border-t border-border px-3 py-1 whitespace-pre-wrap text-deleted select-text">
          {e.error}
        </div>
      ) : null}
    </div>
  );
}
