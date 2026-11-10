import { useConfig } from "../store/config";
import { useUI } from "../store/store";

/**
 * Dismissible banner listing ~/.kubewing/ problems; the app runs on defaults
 * for the broken parts. Hidden while the settings editor is open, which lists
 * the problems of the text being edited itself (the banner's are the saved
 * files'); back once it closes.
 */
export function ConfigErrors() {
  const errors = useConfig((s) => s.errors);
  const dir = useConfig((s) => s.config?.dir);
  const dismissed = useConfig((s) => s.dismissed);
  const editing = useUI((s) => s.overlay?.kind === "config");
  if (!errors.length || dismissed || editing) return null;
  return (
    <div role="alert" aria-label="config errors" className="flex shrink-0 gap-3 border-b border-deleted bg-bg-elev px-3 py-1">
      <div className="min-w-0 flex-1">
        <div className="text-deleted">
          config problems in {dir} (defaults used for these; ⌘⇧, reloads)
        </div>
        <ul className="text-fg-muted">
          {errors.map((e, i) => (
            <li key={i} className="truncate select-text">
              {e}
            </li>
          ))}
        </ul>
      </div>
      <button aria-label="dismiss" className="self-start text-fg-muted" onClick={() => useConfig.setState({ dismissed: true })}>
        ✕
      </button>
    </div>
  );
}
