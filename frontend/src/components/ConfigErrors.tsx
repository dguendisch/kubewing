import { useConfig } from "../store/config";

/** Dismissible banner listing ~/.kubewing/ problems; the app runs on defaults for the broken parts. */
export function ConfigErrors() {
  const errors = useConfig((s) => s.errors);
  const dir = useConfig((s) => s.config?.dir);
  const dismissed = useConfig((s) => s.dismissed);
  if (!errors.length || dismissed) return null;
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
