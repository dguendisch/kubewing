import { pickContainer } from "../commands";
import { setUI, useUI } from "../store/store";

/**
 * e on a pod with more than one container exec can enter: which one. The
 * default is highlighted, so x ⏎ enters it; containers that aren't
 * running are listed with their state but skipped. j/k or arrows move, ⏎ (or
 * a click) execs, Esc cancels. The exec is already prepared (the safety
 * policy said yes); a confirmation, if the rule asks for one, comes after.
 */
export function ContainerPicker() {
  const o = useUI((s) => (s.overlay?.kind === "container" ? s.overlay : undefined));
  if (!o?.pending || !o.containers) return null;
  const index = o.index ?? 0;
  return (
    <div
      role="menu"
      aria-label={`exec into ${o.pending.action.name}`}
      className="absolute top-24 left-1/2 z-40 flex w-80 -translate-x-1/2 flex-col border border-accent bg-bg-elev py-1 shadow-2xl"
    >
      <div className="border-b border-border px-3 pb-1 text-fg-muted">
        exec into <span className="text-fg">{o.pending.action.name}</span>
      </div>
      {o.containers.map((c, i) => (
        <button
          key={c.name}
          role="menuitem"
          aria-disabled={c.disabled ? true : undefined}
          title={c.disabled}
          data-active={i === index || undefined}
          className={`flex w-full items-baseline gap-2 px-3 py-0.5 text-left ${i === index ? "bg-bg-hover" : ""} ${c.disabled ? "text-fg-muted" : "text-fg"}`}
          onMouseMove={() => {
            if (!c.disabled) setUI((s) => (s.overlay?.kind === "container" && s.overlay.index !== i ? { ...s, overlay: { ...s.overlay, index: i } } : s));
          }}
          onClick={() => void pickContainer(c.name)}
        >
          <span>{c.name}</span>
          <span className="ml-auto truncate text-[11px] text-fg-muted">{c.detail}</span>
        </button>
      ))}
      <div className="border-t border-border px-3 pt-1 text-fg-muted">⏎ exec · esc cancel</div>
    </div>
  );
}
