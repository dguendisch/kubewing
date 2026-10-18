import { useState } from "react";
import { dispatch } from "../commands";
import { paneIds } from "../store/layout";
import { useUI } from "../store/store";
import { ruleColor } from "./safetyStyle";

/**
 * Confirmation for a prepared mutation (the safety rule asked for it).
 * ⏎ confirms, Esc cancels and restores focus. Strict rules require typing
 * the object name first.
 */
export function Confirm() {
  const overlay = useUI((s) => s.overlay);
  if (overlay?.kind !== "confirm" || !overlay.pending) return null;
  return <ConfirmDialog key={overlay.pending.token} />;
}

function ConfirmDialog() {
  const p = useUI((s) => s.overlay!.pending!);
  const [typed, setTyped] = useState("");
  const ok = !p.typeToConfirm || typed === p.typeToConfirm;
  const color = ruleColor(p.rule);
  return (
    <form
      role="alertdialog"
      aria-label={`confirm ${p.action.kind}`}
      aria-describedby="confirm-summary"
      className="absolute top-24 left-1/2 z-40 flex w-[30rem] -translate-x-1/2 flex-col gap-3 border-2 bg-bg-elev p-3 shadow-2xl"
      style={{ borderColor: color ?? "var(--color-deleted)" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) dispatch("confirm.accept");
      }}
    >
      <h2 className="flex items-baseline gap-2">
        {p.rule.label ? (
          <span className="px-1 font-semibold text-bg" style={{ background: color ?? "var(--color-accent)" }}>
            {p.rule.label}
          </span>
        ) : null}
        <span className="font-semibold text-deleted">{p.action.kind}?</span>
      </h2>
      <p id="confirm-summary" className="text-fg select-text">
        {p.summary}
      </p>
      {p.typeToConfirm ? (
        <label className="flex flex-col gap-1 text-fg-muted">
          type <span className="text-fg">{p.typeToConfirm}</span> to confirm
          <input
            autoFocus
            aria-label="type to confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent"
          />
        </label>
      ) : (
        // focus target so ⏎ submits the form
        <button autoFocus type="submit" className="self-start rounded border border-deleted px-3 py-0.5 text-deleted outline-none focus:bg-deleted/15">
          {p.action.kind}
        </button>
      )}
      <div className="text-fg-muted">⏎ {p.action.kind} · esc cancel</div>
    </form>
  );
}

/** ⌘W on a tab holding more than one pane. ⏎ closes it, Esc keeps it. */
export function ConfirmCloseTab() {
  const tabId = useUI((s) => (s.overlay?.kind === "closeTab" ? s.overlay.tabId : undefined));
  const panes = useUI((s) => {
    const t = s.tabs.find((x) => x.id === tabId);
    return t ? paneIds(t.layout).length : 0;
  });
  if (!tabId) return null;
  return (
    <form
      role="alertdialog"
      aria-label="confirm close tab"
      className="absolute top-24 left-1/2 z-40 flex w-[30rem] -translate-x-1/2 flex-col gap-3 border-2 border-accent bg-bg-elev p-3 shadow-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        dispatch("confirm.accept");
      }}
    >
      <h2 className="font-semibold text-fg">close tab?</h2>
      <p className="text-fg">It holds {panes} panes.</p>
      <button autoFocus type="submit" className="self-start rounded border border-accent px-3 py-0.5 text-accent outline-none focus:bg-accent/15">
        close tab
      </button>
      <div className="text-fg-muted">⏎ close · esc cancel</div>
    </form>
  );
}
