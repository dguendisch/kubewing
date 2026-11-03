import { useState } from "react";
import { dispatch } from "../commands";
import { paneIds } from "../store/layout";
import { useUI } from "../store/store";
import * as S from "../store/state";
import { ruleColor } from "./safetyStyle";

/**
 * Confirmation for a prepared mutation (the safety rule asked for it).
 * ⏎ confirms, Esc cancels and restores focus. Strict rules require typing
 * the object name first.
 */
export function Confirm() {
  const overlay = useUI((s) => s.overlay);
  if (overlay?.kind !== "confirm") return null;
  if (overlay.batch) return <ConfirmBatch key={overlay.batch.pending[0]!.token} />;
  if (!overlay.pending) return null;
  return <ConfirmDialog key={overlay.pending.token} />;
}

/** Listed in a batch's confirmation; the rest are counted. */
const listed = 12;

/**
 * An action on the marked rows: their names listed (the first ones, the
 * rest counted), with what changes; a strict rule (or a big delete) asks
 * for their count to be typed.
 */
function ConfirmBatch() {
  const b = useUI((s) => s.overlay!.batch!);
  const debug = useUI((s) => s.overlay!.debug);
  const meta = useUI((s) => s.overlay!.meta);
  const scale = useUI((s) => s.overlay!.scale);
  const [typed, setTyped] = useState("");
  const ok = !b.typeToConfirm || typed.trim() === b.typeToConfirm;
  const color = ruleColor(b.rule);
  return (
    <form
      role="alertdialog"
      aria-label={`confirm ${b.kind}`}
      aria-describedby="confirm-summary"
      className="absolute top-24 left-1/2 z-40 flex w-[32rem] -translate-x-1/2 flex-col gap-3 border-2 bg-bg-elev p-3 shadow-2xl"
      style={{ borderColor: color ?? "var(--color-deleted)" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) dispatch("confirm.accept");
      }}
    >
      <h2 className="flex items-baseline gap-2">
        {b.rule.label ? (
          <span className="px-1 font-semibold text-bg" style={{ background: color ?? "var(--color-accent)" }}>
            {b.rule.label}
          </span>
        ) : null}
        <span className="font-semibold text-deleted">{b.kind}?</span>
      </h2>
      <p id="confirm-summary" className="text-fg select-text">
        {b.summary}
        {debug ? ` (image ${debug.image}, profile ${debug.profile || "general"}${debug.target && debug.target !== "-" ? `, target ${debug.target}` : ""})` : null}
        {meta ? `: ${meta.text}` : null}
        {scale ? ` to ${scale.replicas}` : null}
      </p>
      <ul aria-label="objects" className="flex max-h-48 flex-col overflow-auto border border-border px-2 py-0.5 text-fg select-text">
        {b.rows.slice(0, listed).map((r) => (
          <li key={r.key} className="flex gap-2">
            <span className="truncate">{r.name}</span>
            {r.namespace ? <span className="text-fg-muted">{r.namespace}</span> : null}
            {scale && r.replicas !== undefined ? <span className="ml-auto text-fg-muted">{r.replicas} → {scale.replicas}</span> : null}
          </li>
        ))}
        {b.rows.length > listed ? <li className="text-fg-muted">and {b.rows.length - listed} more</li> : null}
      </ul>
      {b.skipped?.length ? <p className="text-fg-muted">skipped: {b.skipped.join(", ")}</p> : null}
      {b.typeToConfirm ? (
        <label className="flex flex-col gap-1 text-fg-muted">
          type <span className="text-fg">{b.typeToConfirm}</span> (the number of objects) to confirm
          <input
            autoFocus
            aria-label="type to confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent"
          />
        </label>
      ) : (
        <button autoFocus type="submit" className="self-start rounded border border-deleted px-3 py-0.5 text-deleted outline-none focus:bg-deleted/15">
          {b.kind} {b.rows.length}
        </button>
      )}
      <div className="text-fg-muted">⏎ {b.kind} · esc cancel</div>
    </form>
  );
}

function ConfirmDialog() {
  const p = useUI((s) => s.overlay!.pending!);
  const container = useUI((s) => s.overlay!.container);
  const debug = useUI((s) => s.overlay!.debug);
  const ops = useUI((s) => s.overlay!.ops);
  const meta = useUI((s) => s.overlay!.meta);
  const scale = useUI((s) => s.overlay!.scale);
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
        {container ? ` (container ${container})` : null}
        {ops ? ` (image ${ops.image}, namespace ${ops.namespace || "default"}${ops.chroot ? ", chroot /host" : ops.hostRoot ? ", host root at /host" : ""}${ops.hostNetwork ? ", host network" : ""}${ops.pv ? `, ${ops.pv} at ${ops.mountPath}${ops.readOnly ? " (ro)" : ""}` : ""}${ops.yaml ? ", edited YAML" : ""})` : null}
        {debug ? ` (image ${debug.image}, profile ${debug.profile || "general"}${debug.target && debug.target !== "-" ? `, target ${debug.target}` : ""})` : null}
        {meta ? `: ${meta.text}` : null}
        {scale ? ` to ${scale.replicas}${scale.from !== undefined ? ` (from ${scale.from})` : ""}` : null}
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

/** ⌘W on a tab holding more than one pane, or an edit not written yet. ⏎ closes it, Esc keeps it. */
export function ConfirmCloseTab() {
  const tabId = useUI((s) => (s.overlay?.kind === "closeTab" ? s.overlay.tabId : undefined));
  const panes = useUI((s) => {
    const t = s.tabs.find((x) => x.id === tabId);
    return t ? paneIds(t.layout).length : 0;
  });
  const edits = useUI((s) => {
    const t = s.tabs.find((x) => x.id === tabId);
    return t ? paneIds(t.layout).filter((id) => S.unsaved(s.panes[id])).length : 0;
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
      <p className="text-fg">
        {panes > 1 ? `It holds ${panes} panes.` : null}
        {edits ? ` ${edits === 1 ? "An edit" : `${edits} edits`} not applied yet would be lost.` : null}
      </p>
      <button autoFocus type="submit" className="self-start rounded border border-accent px-3 py-0.5 text-accent outline-none focus:bg-accent/15">
        close tab
      </button>
      <div className="text-fg-muted">⏎ close · esc cancel</div>
    </form>
  );
}

/** Closing a pane (⌃D, a split object view's Esc) whose editor has changes not applied. ⏎ closes it, Esc keeps it. */
export function ConfirmClosePane() {
  const paneId = useUI((s) => (s.overlay?.kind === "closePane" ? s.overlay.pane : undefined));
  if (!paneId) return null;
  return (
    <form
      role="alertdialog"
      aria-label="confirm close pane"
      className="absolute top-24 left-1/2 z-40 flex w-[30rem] -translate-x-1/2 flex-col gap-3 border-2 border-accent bg-bg-elev p-3 shadow-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        dispatch("confirm.accept");
      }}
    >
      <h2 className="font-semibold text-fg">close pane?</h2>
      <p className="text-fg">Its edit isn't applied yet and would be lost.</p>
      <button autoFocus type="submit" className="self-start rounded border border-accent px-3 py-0.5 text-accent outline-none focus:bg-accent/15">
        close pane
      </button>
      <div className="text-fg-muted">⏎ close · esc cancel</div>
    </form>
  );
}
