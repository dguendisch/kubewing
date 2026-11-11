import { useEffect, useState } from "react";
import { submitOpsPod } from "../commands";
import { Combobox } from "../complete/Combobox";
import { useCatalog } from "../complete/useCatalog";
import { Editor } from "../editor/Editor";
import { useConfig } from "../store/config";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import type { NodeList, OpsPodDefaults, OpsPodOptions, PVList } from "../transport/types";
import { checkOpsPod, initialOpsPod, nodeCandidates, opsImageSuggestions, opsNamespaceCandidates, opsPodHint, pvCandidates, pvNamespace } from "./opsPodForm";

/** Poll interval while a watch lists, and to keep its lease while the dialog is open. */
const POLL_MS = 250;
const KEEP_MS = 10_000;

/** Polls a leased watch (nodes, PVs) while `active`: fast until it listed, then slowly to keep Go's lease. */
function useLeased<T extends { loading?: boolean }>(fetch: () => Promise<T>, active: boolean, deps: unknown[]): T | undefined {
  const [data, setData] = useState<T>();
  useEffect(() => {
    if (!active) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      fetch().then(
        (l) => {
          if (stop) return;
          setData(l);
          timer = setTimeout(load, l.loading ? POLL_MS : KEEP_MS);
        },
        () => {},
      );
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [active, ...deps]);
  return data;
}

/**
 * n (and Object → Node Shell…): an ops pod on a node (ops-toolbelt's hacks/ops-pod).
 * The node is prefilled from the selected row (a node, or the node a pod
 * runs on) and completes from the context's nodes: Go's shared nodes watch,
 * i.e. an open nodes pane's data if there is one. Image (shared history
 * with debug containers, ✕ forgets one), namespace, the host access
 * checkboxes and optionally a persistent volume (mounted through its bound
 * claim, so the pod runs in the claim's namespace). "show YAML" renders the
 * pod Go would create; edited, that YAML is what starts (Go checks it keeps
 * node, name, namespace and the ops-pod container). ⏎ on a highlighted
 * suggestion takes it, ⏎ otherwise starts (⌘⏎ in the YAML); Go checks the
 * safety policy then, and a confirmation, if the rule asks for one, comes
 * after. Esc closes the YAML, then the dialog.
 */
export function OpsPodDialog() {
  const o = useUI((s) => (s.overlay?.kind === "opspod" ? s.overlay : undefined));
  const cluster = useUI((s) => (s.overlay?.kind === "opspod" ? (s.panes[s.overlay.pane]?.spec.context ?? "") : ""));
  if (!o) return null;
  return <Dialog key={`${o.pane}/${o.node ?? ""}`} cluster={cluster} initialNode={o.node ?? ""} defaults={o.opsDefaults} />;
}

function Dialog({ cluster, initialNode, defaults }: { cluster: string; initialNode: string; defaults?: OpsPodDefaults }) {
  const cfg = useConfig((s) => s.config?.config.opsPod);
  const [node, setNode] = useState(initialNode);
  const [recent, setRecent] = useState<string[]>([]);
  // loaded before the dialog opened (last used, else config.yaml, else defaults): nothing typed is overwritten
  const [opts, setOpts] = useState<OpsPodOptions>(() => initialOpsPod(defaults));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // the rendered pod (show YAML) and what it was edited to; set = the YAML is what starts
  const [yaml, setYaml] = useState<{ rendered: string; text: string }>();
  // PVs are fetched once the field is used: listing them may be forbidden, and most ops pods don't need one
  const [wantPVs, setWantPVs] = useState(false);
  // Esc on edited YAML asks first (a second Esc drops the edits): WKWebView has no window.confirm
  const [dropAsked, setDropAsked] = useState(false);
  // namespaces complete from the context's catalog, as in ⌘O
  const cat = useCatalog(cluster, true);
  const lastNamespace = defaults?.remembered ? defaults.namespace : "";
  const nodes = useLeased<NodeList>(() => bridge().nodes(cluster), true, [cluster]);
  const pvs = useLeased<PVList>(() => bridge().persistentVolumes(cluster), wantPVs, [cluster]);
  // a PV's claim is in one namespace; a pod mounts it only from there. We don't overwrite
  // the namespace field (the user may have set it on purpose) — just flag a real conflict.
  const claimNs = opts.pv ? pvNamespace(pvs?.pvs ?? [], opts.pv) : undefined;
  const nsConflict = claimNs && opts.namespace.trim() && opts.namespace.trim() !== claimNs ? claimNs : undefined;
  const locked = !!yaml;

  useEffect(() => {
    bridge().debugImages().then(setRecent, () => {});
  }, []);

  const set = (k: "image" | "namespace" | "pv" | "mountPath") => (v: string) => {
    setError(undefined);
    setOpts((x) => ({ ...x, [k]: v }));
  };
  const toggle = (k: "chroot" | "hostRoot" | "hostNetwork" | "readOnly") => (on: boolean) => {
    setError(undefined);
    setOpts((x) => {
      const next = { ...x, [k]: on };
      // chroot needs the mount; no mount means no chroot either
      if (k === "chroot" && on) next.hostRoot = true;
      if (k === "hostRoot" && !on) next.chroot = false;
      return next;
    });
  };
  // ⏎ in a field passes its final value (an accepted suggestion) along
  const submit = (n: string, o: OpsPodOptions) => {
    if (busy) return;
    const r = checkOpsPod(n, { ...o, yaml: yaml?.text }, nodes?.nodes);
    if ("error" in r) return setError(r.error);
    setBusy(true);
    void submitOpsPod(cluster, r.node, r.opts).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };
  const showYaml = () => {
    const r = checkOpsPod(node, opts, nodes?.nodes);
    if ("error" in r) return setError(r.error);
    setError(undefined);
    void bridge()
      .opsPodManifest(cluster, r.node, r.opts)
      .then((y) => setYaml({ rendered: y, text: y }), (e) => setError(String((e as Error)?.message ?? e)));
  };
  const hideYaml = () => {
    if (yaml && yaml.text !== yaml.rendered && !dropAsked) return setDropAsked(true);
    setDropAsked(false);
    setYaml(undefined);
    setError(undefined);
  };
  const field = "rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent disabled:opacity-60";
  const nodeHint = nodes?.error ? `nodes: ${nodes.error}` : !nodes || nodes.loading ? "loading nodes…" : undefined;
  const pvHint = pvs?.error ? `persistent volumes: ${pvs.error}` : wantPVs && (!pvs || pvs.loading) ? "loading persistent volumes…" : undefined;
  const check = (k: "chroot" | "hostRoot" | "hostNetwork" | "readOnly", label: string) => (
    <label className="flex items-center gap-1.5 text-fg">
      <input
        type="checkbox"
        checked={!!opts[k]}
        disabled={locked}
        onChange={(e) => toggle(k)(e.target.checked)}
        // ⏎ on a checkbox starts, as from any field
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit(node, opts);
          }
        }}
        className="accent-accent"
      />
      {label}
    </label>
  );

  return (
    <form
      role="dialog"
      aria-label="node shell"
      className={`absolute top-16 left-1/2 z-30 flex ${yaml ? "w-[min(76rem,96vw)]" : "w-[34rem]"} -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-dialog`}
      onSubmit={(e) => {
        e.preventDefault();
        submit(node, opts);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Monaco's find widget closes first
        if (e.target instanceof Element && e.target.closest(".find-widget.visible")) return;
        if (yaml) {
          e.preventDefault();
          return hideYaml();
        }
        setUI(S.closeOverlay);
      }}
    >
      <div className="text-fg">
        node shell <span className="text-fg-muted">on a node of {nodes?.context || S.splitCluster(cluster).context || "the current context"}</span>
      </div>
      <div className="flex min-h-0 gap-3">
        <div className="flex w-[32rem] shrink-0 flex-col gap-2">
          {/* while the YAML is shown it's what starts: the form beside it is read-only, so it's clear which one counts */}
          <fieldset disabled={locked} className="flex min-w-0 flex-col gap-2">
            <label className="flex flex-col gap-1 text-fg-muted">
              node
              <Combobox
                label="node"
                autoFocus
                value={node}
                onChange={(v) => {
                  setError(undefined);
                  setNode(v);
                }}
                enterAccepts
                onSubmit={(n) => submit(n, opts)}
                candidates={nodeCandidates(nodes?.nodes ?? [])}
                hint={nodeHint}
                placeholder="node name"
                className={`w-full ${field} ${error ? "border-deleted" : ""}`}
              />
            </label>
            <label className="flex flex-col gap-1 text-fg-muted">
              image
              <Combobox
                label="image"
                value={opts.image}
                onChange={set("image")}
                enterAccepts
                onSubmit={(image) => submit(node, { ...opts, image })}
                // one history with debug containers; the configured image belongs to config.yaml
                candidates={opsImageSuggestions(cfg, recent).map((i) => ({ value: i, label: i, detail: i === cfg?.image ? "config.yaml" : undefined, removable: i !== cfg?.image }))}
                onRemove={(c) => void bridge().removeDebugImage(c.value).then(setRecent, () => {})}
                placeholder="e.g. the ops-toolbelt image"
                className={`w-full ${field}`}
              />
            </label>
            <label className="flex flex-col gap-1 text-fg-muted">
              namespace
              {claimNs && !opts.namespace.trim() ? <span className="text-small">empty → the volume's claim namespace {claimNs}</span> : null}
              <Combobox
                label="namespace"
                value={opts.namespace}
                onChange={set("namespace")}
                enterAccepts
                onSubmit={(namespace) => submit(node, { ...opts, namespace })}
                candidates={opsNamespaceCandidates(cat.namespaces, lastNamespace)}
                hint={nsConflict ? `the volume mounts only in its claim's namespace ${nsConflict}` : cat.errors?.namespaces ? `namespaces: ${cat.errors.namespaces}` : undefined}
                placeholder={claimNs ?? "default"}
                className={`w-full ${field} ${nsConflict ? "border-deleted" : ""}`}
              />
            </label>
            <div role="group" aria-label="host access" className="flex flex-wrap gap-x-4 gap-y-1">
              {check("chroot", "chroot into /host")}
              {check("hostRoot", "host root at /host")}
              {check("hostNetwork", "host network")}
            </div>
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-[3] flex-col gap-1 text-fg-muted" onFocus={() => setWantPVs(true)}>
                persistent volume (optional)
                <Combobox
                  label="persistent volume"
                  value={opts.pv ?? ""}
                  onChange={set("pv")}
                  enterAccepts
                  onSubmit={(pv) => submit(node, { ...opts, pv })}
                  candidates={pvCandidates(pvs?.pvs ?? [])}
                  hint={pvHint}
                  placeholder="none"
                  className={`w-full ${field}`}
                />
              </label>
              <label className="flex min-w-0 flex-[2] flex-col gap-1 text-fg-muted">
                mount path
                <input
                  aria-label="mount path"
                  value={opts.mountPath ?? ""}
                  onChange={(e) => set("mountPath")(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  // ⏎ here starts too (empty = the shown /pv); a plain input wouldn't submit on its own
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submit(node, opts);
                    }
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="/pv"
                  className={`w-full ${field}`}
                />
              </label>
              <div className="pb-1">{check("readOnly", "read-only")}</div>
            </div>
          </fieldset>
          <div className="text-small text-fg-muted">{opsPodHint(opts)}</div>
        </div>
        {yaml ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-baseline gap-2 text-fg-muted">
                <span className="text-fg">pod YAML</span>
                {yaml.text !== yaml.rendered ? <span className="text-changed">edited: this is what starts</span> : <span>this is what starts</span>}
                <button type="button" onClick={hideYaml} className="ml-auto rounded border border-border px-1.5 hover:border-accent">
                  back to the form
                </button>
              </div>
              {/* the whole pod fits (~45 lines) where the window allows: Monaco only renders what's visible */}
              <div className="h-[min(44rem,calc(100vh-12rem))] border border-border">
                <Editor
                  label="pod YAML"
                  initial={yaml.rendered}
                  onChange={(text) => {
                    setDropAsked(false);
                    setYaml((y) => (y ? { ...y, text } : y));
                  }}
                  onSubmit={() => submit(node, opts)}
                />
              </div>
            </div>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="text-deleted select-text">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-fg-muted">
        <span className={dropAsked ? "text-changed" : ""}>
          {busy ? "preparing…" : dropAsked ? "esc again drops the YAML edits" : yaml ? "⌘⏎ start · esc back to the form" : "⏎ start · ⇥ next field · space toggles · esc cancel"}
        </span>
        {!yaml ? (
          <button type="button" onClick={showYaml} className="ml-auto rounded border border-border px-1.5 text-fg hover:border-accent">
            show YAML…
          </button>
        ) : null}
      </div>
    </form>
  );
}
