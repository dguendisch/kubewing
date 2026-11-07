import { useEffect, useRef, useState } from "react";
import { bridge, setUI, usePortForwards, useUI } from "../store/store";
import * as S from "../store/state";
import { Markdown } from "./Markdown";
import { hint, megabytes, resolveLink, restartWarning, scheduleText, summary, useUpdate } from "./update";
import { openUpdate } from "../commands";

const openLink = (url: string) => void bridge().openURL(url).catch(() => {});

/** The tab bar's hint: a newer version is out (not skipped). A click shows its release notes. */
export function UpdateHint() {
  const offer = useUpdate((u) => hint(u.status));
  const installing = useUpdate((u) => u.status?.installing);
  const focused = useUI((s) => S.focusedPane(s).id);
  if (!offer) return null;
  return (
    <button
      type="button"
      aria-label="update available"
      title={`kubewing ${offer.version} is available: what's new`}
      className="self-center rounded px-2 text-accent hover:bg-fg/10"
      onClick={() => openUpdate(focused, false)}
    >
      {installing ? "⬆ updating…" : `⬆ ${offer.version}`}
    </button>
  );
}

/**
 * The release notes of every version between the running one and the
 * offered one (Markdown, from the releases), with update / skip / later.
 * Opened by the hint or the app menu's "Check for Updates…" (which checks).
 */
export function UpdateDialog() {
  const open = useUI((s) => s.overlay?.kind === "update");
  if (!open) return null;
  return <Dialog />;
}

function Dialog() {
  const st = useUpdate((u) => u.status);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  // sessions a restart would end: terminals, log tails, port-forwards
  const sessions = useUI((s) => Object.values(s.panes).filter((p) => p.term?.session || p.logs?.session).length);
  const forwards = usePortForwards((f) => f.list.length);
  const offer = st?.offer;
  const installing = !!st?.installing;

  useEffect(() => {
    (primary.current ?? el.current)?.focus();
  }, [!!offer, confirming]);

  const close = () => setUI((s) => (s.overlay?.kind === "update" ? S.closeOverlay(s) : s));
  const install = () => {
    setBusy(true);
    // the app quits once it's installed; a failure comes back as the status' error
    void bridge()
      .installUpdate()
      .catch(() => {})
      .finally(() => {
        setBusy(false);
        setConfirming(false);
      });
  };
  const update = () => {
    if (!offer) return;
    if (st.cannotInstall) return openLink(offer.url);
    if (!confirming) return setConfirming(true);
    install();
  };

  const line = summary(st);
  return (
    <div
      ref={el}
      role="dialog"
      aria-modal="true"
      aria-label="update"
      tabIndex={-1}
      className="absolute top-12 left-1/2 z-40 flex max-h-[calc(100%-6rem)] w-[44rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col border-2 border-accent bg-bg-elev shadow-2xl outline-none"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (confirming && !installing) return setConfirming(false);
        if (!installing) close();
      }}
    >
      <h2 className="shrink-0 border-b border-border px-3 py-1 font-semibold text-fg">{offer ? "what's new" : "check for updates"}</h2>
      <div aria-live="polite" className="shrink-0 px-3 pt-2 text-fg">
        {line}
        {st?.installing === "download" ? (
          <div role="progressbar" aria-label="download" aria-valuenow={Math.floor((st.progress ?? 0) * 100)} className="mt-1 h-1 w-full bg-bg">
            <div className="h-full bg-accent" style={{ width: `${Math.floor((st.progress ?? 0) * 100)}%` }} />
          </div>
        ) : null}
      </div>
      {st?.error ? (
        <div role="alert" aria-label="update error" className="shrink-0 px-3 pt-1 break-words text-deleted select-text">
          {st.error}
        </div>
      ) : null}
      {offer ? (
        <div aria-label="release notes" className="min-h-0 flex-1 overflow-auto px-3 py-2 text-fg-muted select-text">
          {offer.notes.map((n) => (
            <section key={n.version} aria-label={`kubewing ${n.version}`} className="mb-3">
              <h3 className="border-b border-border pb-0.5 text-fg">
                <span className="font-semibold">{n.version}</span>
                {n.prerelease ? <span className="ml-2 text-changed">release candidate</span> : null}
                {n.date ? <span className="ml-2 text-fg-muted">{n.date}</span> : null}
              </h3>
              {n.body ? <Markdown text={n.body} onLink={openLink} resolve={(h) => resolveLink(h, n.version)} /> : <p className="my-1 italic">no notes</p>}
            </section>
          ))}
        </div>
      ) : null}
      {confirming && offer && !st.cannotInstall ? (
        <div role="alert" aria-label="restart warning" className="shrink-0 border-t border-border px-3 py-1 text-changed">
          {restartWarning(sessions, forwards)}. Update now?
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
        {offer ? (
          <>
            <button
              ref={primary}
              type="button"
              disabled={installing || busy}
              title={st.cannotInstall ? `${st.cannotInstall}: opens the release page` : undefined}
              className="shrink-0 whitespace-nowrap rounded border border-accent px-3 py-0.5 text-accent outline-none focus:bg-accent/15 disabled:opacity-50"
              onClick={update}
            >
              {st.cannotInstall ? "download…" : confirming ? "restart and update" : `update to ${offer.version}${offer.size ? ` (${megabytes(offer.size)})` : ""}`}
            </button>
            {!installing && offer.version !== st.skipped ? (
              <button type="button" className="shrink-0 whitespace-nowrap rounded border border-border px-3 py-0.5 text-fg-muted outline-none focus:border-accent" onClick={() => void bridge().skipUpdate(offer.version).then(close, () => {})}>
                skip this version
              </button>
            ) : null}
            {!installing ? (
              <button type="button" className="shrink-0 whitespace-nowrap rounded border border-border px-3 py-0.5 text-fg-muted outline-none focus:border-accent" onClick={close}>
                later
              </button>
            ) : null}
          </>
        ) : (
          <>
            <button
              ref={primary}
              type="button"
              disabled={st?.checking}
              className="shrink-0 whitespace-nowrap rounded border border-accent px-3 py-0.5 text-accent outline-none focus:bg-accent/15 disabled:opacity-50"
              onClick={() => void bridge().checkUpdate().then((s) => useUpdate.setState({ status: s }), () => {})}
            >
              check again
            </button>
            <button type="button" className="shrink-0 whitespace-nowrap rounded border border-border px-3 py-0.5 text-fg-muted outline-none focus:border-accent" onClick={close}>
              close
            </button>
          </>
        )}
        <span className="ml-auto min-w-0 truncate text-fg-muted" title={(st?.cannotInstall && offer ? `${st.cannotInstall} · ` : "") + (st ? scheduleText(st.checkDays) : "") + " · esc"}>
          {st?.cannotInstall && offer ? `${st.cannotInstall} · ` : ""}
          {st ? scheduleText(st.checkDays) : ""} · esc
        </span>
      </div>
    </div>
  );
}
