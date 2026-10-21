import { useEffect, useState } from "react";
import { submitOpsPod } from "../commands";
import { Combobox } from "../complete/Combobox";
import { useConfig } from "../store/config";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { useCatalog } from "../complete/useCatalog";
import type { NodeList, OpsPodDefaults, OpsPodOptions } from "../transport/types";
import { checkOpsPod, initialOpsPod, nodeCandidates, opsImageSuggestions, opsNamespaceCandidates, opsPodHint } from "./opsPodForm";

/** Poll interval while the nodes watch lists, and to keep its lease while the dialog is open. */
const NODES_POLL_MS = 250;
const NODES_KEEP_MS = 10_000;

/**
 * ⌘⌥O: an ops pod on a node (ops-toolbelt's hacks/ops-pod), from anywhere.
 * The node is prefilled from the selected row (a node, or the node a pod
 * runs on) and completes from the context's nodes: Go's shared nodes watch,
 * i.e. an open nodes pane's data if there is one. Image (shared history
 * with debug containers, ✕ forgets one), namespace and the host access
 * checkboxes default from config.yaml's opsPod. ⏎ on a highlighted
 * suggestion takes it, ⏎ otherwise starts (Go checks the safety policy
 * then; a confirmation, if the rule asks for one, comes after); Esc cancels.
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
  const [nodes, setNodes] = useState<NodeList>();
  const [recent, setRecent] = useState<string[]>([]);
  // loaded before the dialog opened (last used, else config.yaml, else defaults): nothing typed is overwritten
  const [opts, setOpts] = useState<OpsPodOptions>(() => initialOpsPod(defaults));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // namespaces complete from the context's catalog, as in ⌘O
  const cat = useCatalog(cluster, true);
  const lastNamespace = defaults?.remembered ? defaults.namespace : "";

  useEffect(() => {
    bridge().debugImages().then(setRecent, () => {});
  }, []);

  // while open: poll fast until the watch listed, then slowly (keeps Go's lease on the watch)
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      bridge()
        .nodes(cluster)
        .then(
          (l) => {
            if (stop) return;
            setNodes(l);
            timer = setTimeout(load, l.loading ? NODES_POLL_MS : NODES_KEEP_MS);
          },
          () => {},
        );
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [cluster]);

  const set = (k: "image" | "namespace") => (v: string) => {
    setError(undefined);
    setOpts((x) => ({ ...x, [k]: v }));
  };
  const toggle = (k: "chroot" | "hostRoot" | "hostNetwork") => (on: boolean) => {
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
    const r = checkOpsPod(n, o, nodes?.nodes);
    if ("error" in r) return setError(r.error);
    setBusy(true);
    void submitOpsPod(cluster, r.node, r.opts).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };
  const field = "rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent";
  const nodeHint = nodes?.error ? `nodes: ${nodes.error}` : !nodes || nodes.loading ? "loading nodes…" : undefined;
  const check = (k: "chroot" | "hostRoot" | "hostNetwork", label: string) => (
    <label className="flex items-center gap-1.5 text-fg">
      <input
        type="checkbox"
        checked={opts[k]}
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
      aria-label="ops pod"
      className="absolute top-16 left-1/2 z-30 flex w-[34rem] -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        submit(node, opts);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <div className="text-fg">
        ops pod on a node <span className="text-fg-muted">of {nodes?.context || cluster || "the current context"}</span>
      </div>
      <label className="flex flex-col gap-1 text-fg-muted">
        node
        <Combobox
          label="node"
          autoFocus
          value={node}
          // ⌘⌥O opens with the nodes listed; ⏎ still takes the prefilled one (nothing highlighted)
          openOnMount
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
        <Combobox
          label="namespace"
          value={opts.namespace}
          onChange={set("namespace")}
          enterAccepts
          onSubmit={(namespace) => submit(node, { ...opts, namespace })}
          candidates={opsNamespaceCandidates(cat.namespaces, lastNamespace)}
          hint={cat.errors?.namespaces ? `namespaces: ${cat.errors.namespaces}` : undefined}
          placeholder="default"
          className={`w-full ${field}`}
        />
      </label>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {check("chroot", "chroot into /host")}
        {check("hostRoot", "host root at /host")}
        {check("hostNetwork", "host network")}
      </div>
      <div className="text-[11px] text-fg-muted">{opsPodHint(opts)}</div>
      {error ? (
        <div role="alert" className="text-deleted">
          {error}
        </div>
      ) : null}
      <div className="text-fg-muted">{busy ? "preparing…" : "⏎ start · ⇥ next field · space toggles · esc cancel"}</div>
    </form>
  );
}
