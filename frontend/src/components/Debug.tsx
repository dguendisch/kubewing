import { useEffect, useState } from "react";
import { submitDebug } from "../commands";
import { Combobox } from "../complete/Combobox";
import { useConfig } from "../store/config";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import type { ContainerInfo, DebugOptions, DebugProfile } from "../transport/types";
import { checkDebug, imageSuggestions, initialDebug, profileCandidates, profileHints, targetCandidates } from "./debugForm";

/**
 * b: a debug container (kubectl debug) in the selected pod. Asks for the
 * image (prefilled from config.yaml's debug.image, else the last one that
 * started; the last 10 are offered, from history.yaml, ✕ forgets one), the container whose
 * processes it shares (the pod's default; empty = none) and the security
 * profile, all completion fields like ⌘O's. The debug is already prepared
 * (the safety policy said yes); a confirmation, if the rule asks for one,
 * comes after. ⏎ on a highlighted suggestion takes it, ⏎ otherwise starts
 * (from any field); Esc cancels.
 */
export function DebugDialog() {
  const o = useUI((s) => (s.overlay?.kind === "debug" ? s.overlay : undefined));
  const serverId = useUI((s) => (s.overlay?.kind === "debug" ? s.panes[s.overlay.pane]?.serverId : undefined));
  if (!o?.pending || !o.key || !serverId) return null;
  return <Dialog key={o.pending.token} serverId={serverId} rowKey={o.key} pod={o.pending.action.name} />;
}

function Dialog({ serverId, rowKey, pod }: { serverId: string; rowKey: string; pod: string }) {
  const cfg = useConfig((s) => s.config?.config.debug);
  const [containers, setContainers] = useState<ContainerInfo[]>();
  const [recent, setRecent] = useState<string[]>([]);
  const [opts, setOpts] = useState<DebugOptions>(() => initialDebug(cfg, []));
  const [error, setError] = useState<string>();

  useEffect(() => {
    bridge()
      .debugImages()
      .then((r) => {
        setRecent(r);
        // nothing configured and nothing typed yet: the last image that started
        setOpts((x) => (x.image ? x : { ...x, image: initialDebug(cfg, [], r).image }));
      }, () => {});
  }, []);

  useEffect(() => {
    bridge()
      .rowInfo(serverId, rowKey)
      .then(
        (r) => {
          const cs = r.containerInfo ?? [];
          setContainers(cs);
          setOpts((x) => (x.target ? x : { ...x, target: initialDebug(cfg, cs).target }));
        },
        () => setContainers([]),
      );
  }, [serverId, rowKey]);

  const set = (k: keyof DebugOptions) => (v: string) => {
    setError(undefined);
    setOpts((x) => ({ ...x, [k]: v }));
  };
  // ⏎ in a field passes its final value (an accepted suggestion) along
  const submit = (o: DebugOptions) => {
    const r = checkDebug(o, containers ?? []);
    if ("error" in r) return setError(r.error);
    void submitDebug(r.opts).then((err) => err && setError(err));
  };
  const field = "rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent";

  return (
    <form
      role="dialog"
      aria-label="debug container"
      className="absolute top-16 left-1/2 z-30 flex w-[30rem] -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        submit(opts);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <div className="text-fg">
        debug container in <span className="font-semibold">{pod}</span>
      </div>
      <label className="flex flex-col gap-1 text-fg-muted">
        image
        {/* suggestions (configured image, history) open on typing or ↓, not on focus */}
        <Combobox
          label="image"
          autoFocus
          value={opts.image}
          onChange={set("image")}
          enterAccepts
          onSubmit={(image) => submit({ ...opts, image })}
          // history entries can be forgotten (✕); the configured image belongs to config.yaml
          candidates={imageSuggestions(cfg, recent).map((i) => ({ value: i, label: i, detail: i === cfg?.image ? "config.yaml" : undefined, removable: i !== cfg?.image }))}
          onRemove={(c) => void bridge().removeDebugImage(c.value).then(setRecent, () => {})}
          placeholder="e.g. busybox, nicolaka/netshoot"
          className={`w-full ${field} ${error ? "border-deleted" : ""}`}
        />
      </label>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1 text-fg-muted">
          target (shares its processes)
          <Combobox
            label="target"
            value={opts.target}
            onChange={set("target")}
            enterAccepts
            onSubmit={(target) => submit({ ...opts, target })}
            candidates={targetCandidates(containers ?? [])}
            placeholder="none"
            className={`w-full ${field}`}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-fg-muted">
          profile
          <Combobox
            label="profile"
            value={opts.profile}
            onChange={set("profile")}
            enterAccepts
            onSubmit={(profile) => submit({ ...opts, profile })}
            candidates={profileCandidates}
            placeholder="general"
            className={`w-full ${field}`}
          />
        </label>
      </div>
      <div className="text-[11px] text-fg-muted">{profileHints[(opts.profile.trim() || "general") as DebugProfile] ?? "\u00a0"}</div>
      {error ? (
        <div role="alert" className="text-deleted">
          {error}
        </div>
      ) : null}
      <div className="text-fg-muted">⏎ start · esc cancel</div>
    </form>
  );
}
