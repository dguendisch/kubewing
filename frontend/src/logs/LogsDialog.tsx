import { useEffect, useRef, useState } from "react";
import { startLogPanes, startLogs } from "../commands";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import type { LogsScope, PodRef } from "../transport/types";
import { checkLogForm, initialLogForm, perPodUnavailable, toggleAllContainers, toggleContainer, type LogForm } from "./options";

/**
 * l / ⌥L: what a log tail shows, before it starts (of a row, the marked
 * rows or the whole pane). The containers its pods
 * have (all checked), how much history (the last lines, since a duration ago,
 * or all), whether to follow, and timestamps. With several pods: a pane
 * per pod instead of one tail, below or in a new tab. ⏎ from anywhere in it starts,
 * so l ⏎ is the defaults.
 */
export function LogsDialog() {
  const o = useUI((s) => (s.overlay?.kind === "logs" ? s.overlay : undefined));
  const serverId = useUI((s) => (s.overlay?.kind === "logs" ? s.panes[s.overlay.pane]?.serverId : undefined));
  if (!o || !serverId) return null;
  const scope = o.scope ?? "row";
  return <Dialog key={`${o.pane}/${o.key ?? ""}/${scope}`} paneId={o.pane} serverId={serverId} rowKey={o.key} scope={scope} />;
}

function Dialog({ paneId, serverId, rowKey, scope }: { paneId: string; serverId: string; rowKey?: string; scope: LogsScope }) {
  const [title, setTitle] = useState<string>();
  const [skipped, setSkipped] = useState<string[]>();
  const [pods, setPods] = useState<PodRef[]>([]);
  // why a pane per pod isn't offered (one pod, too many)
  const perPodOff = perPodUnavailable(pods.length);
  const [form, setForm] = useState<LogForm>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const history = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bridge()
      .logsTargets(serverId, rowKey ?? "", scope)
      .then(
        (t) => {
          setTitle(t.title);
          setSkipped(t.skipped);
          setPods(t.pods ?? []);
          setForm(initialLogForm(t.containers, t.tail));
        },
        (e) => setError(String((e as Error)?.message ?? e)),
      );
  }, [serverId, rowKey, scope]);

  // the history field has the focus once the form is there: ⏎ starts, typing changes it
  useEffect(() => {
    if (form) history.current?.focus();
  }, [!!form]);

  const update = (f: LogForm) => {
    setError(undefined);
    setForm(f);
  };
  const submit = () => {
    if (!form || busy) return;
    const opts = checkLogForm(form);
    if (typeof opts === "string") return setError(opts);
    setBusy(true);
    const started = form.perPod && !perPodOff ? startLogPanes(paneId, rowKey, scope, opts, form.timestamps, pods, form.newTab) : startLogs(paneId, rowKey, scope, opts, form.timestamps);
    void started.then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };
  // ⏎ on a checkbox starts, as from the field
  const enterSubmits = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };
  const field = "rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent";
  const many = (form?.containers.length ?? 0) > 1;

  return (
    <form
      role="dialog"
      aria-label="logs"
      className="absolute top-16 left-1/2 z-30 flex w-[30rem] -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-dialog"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <div className="text-fg">
        logs of <span className="font-semibold">{title ?? "…"}</span>
      </div>
      {skipped?.length ? (
        <div className="text-fg-muted">
          skipped (no pods): {skipped.length > 3 ? `${skipped.slice(0, 3).join(", ")} +${skipped.length - 3}` : skipped.join(", ")}
        </div>
      ) : null}
      {form ? (
        <>
          {form.containers.length ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-fg-muted">containers</legend>
              <div role="group" aria-label="containers" className="flex flex-wrap gap-x-4 gap-y-1">
                {many ? (
                  <label className="flex items-center gap-1.5 text-fg-muted">
                    <input
                      type="checkbox"
                      aria-label="all containers"
                      checked={form.picked.length === form.containers.length}
                      ref={(el) => {
                        if (el) el.indeterminate = form.picked.length > 0 && form.picked.length < form.containers.length;
                      }}
                      onChange={() => update(toggleAllContainers(form))}
                      onKeyDown={enterSubmits}
                      className="accent-accent"
                    />
                    all
                  </label>
                ) : null}
                {form.containers.map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-fg">
                    <input type="checkbox" checked={form.picked.includes(c)} onChange={() => update(toggleContainer(form, c))} onKeyDown={enterSubmits} className="accent-accent" />
                    {c}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <div className="text-fg-muted">no pods yet: every container of the pods that come</div>
          )}
          <label className="flex flex-col gap-1 text-fg-muted">
            history
            <input
              ref={history}
              aria-label="history"
              value={form.history}
              onChange={(e) => update({ ...form, history: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              autoComplete="off"
              spellCheck={false}
              placeholder="100, 10m or all"
              className={`${field} ${error ? "border-deleted" : ""}`}
            />
            <span className="text-[11px]">the last lines per container (100), since a duration ago (10m, 1h30m), or all</span>
          </label>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-fg">
              <input type="checkbox" checked={form.follow} onChange={(e) => update({ ...form, follow: e.target.checked })} onKeyDown={enterSubmits} className="accent-accent" />
              follow
            </label>
            <label className="flex items-center gap-1.5 text-fg">
              <input type="checkbox" checked={form.timestamps} onChange={(e) => update({ ...form, timestamps: e.target.checked })} onKeyDown={enterSubmits} className="accent-accent" />
              timestamps
            </label>
          </div>
          {pods.length > 1 ? (
            <div className="flex gap-4">
              <label className={`flex items-center gap-1.5 ${perPodOff ? "text-fg-muted" : "text-fg"}`} title={perPodOff}>
                <input
                  type="checkbox"
                  aria-label="a pane per pod"
                  checked={form.perPod && !perPodOff}
                  disabled={!!perPodOff}
                  onChange={(e) => update({ ...form, perPod: e.target.checked })}
                  onKeyDown={enterSubmits}
                  className="accent-accent"
                />
                a pane per pod ({perPodOff ?? pods.length})
              </label>
              <label className={`flex items-center gap-1.5 ${form.perPod && !perPodOff ? "text-fg" : "text-fg-muted"}`}>
                <input
                  type="checkbox"
                  aria-label="in a new tab"
                  checked={form.newTab}
                  disabled={!form.perPod || !!perPodOff}
                  onChange={(e) => update({ ...form, newTab: e.target.checked })}
                  onKeyDown={enterSubmits}
                  className="accent-accent"
                />
                in a new tab
              </label>
            </div>
          ) : null}
        </>
      ) : !error ? (
        <div className="text-fg-muted">listing the pods…</div>
      ) : null}
      {error ? (
        <div role="alert" className="text-deleted select-text">
          {error}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2 text-fg-muted">
        <span className="mr-auto text-[11px]">⏎ starts · esc cancels</span>
        <button type="button" onClick={() => setUI(S.closeOverlay)} className="rounded border border-border px-2 py-0.5 hover:border-accent">
          cancel
        </button>
        <button type="submit" disabled={!form || busy} className="rounded border border-accent px-2 py-0.5 text-fg hover:bg-bg-hover disabled:opacity-60">
          start
        </button>
      </div>
    </form>
  );
}
