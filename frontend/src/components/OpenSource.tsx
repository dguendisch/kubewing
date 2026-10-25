import { useEffect, useState } from "react";
import { openSource } from "../commands";
import { Combobox } from "../complete/Combobox";
import { findResource, namespaceCandidates, resourceCandidates } from "../complete/complete";
import { useCatalog, type CatalogState } from "../complete/useCatalog";
import { bridge, setUI, useContexts, useUI } from "../store/store";
import * as S from "../store/state";

/** ⌘O: choose context / resource / namespace for the focused pane. */
export function OpenSource() {
  const overlay = useUI((s) => s.overlay);
  const pane = useUI((s) => (s.overlay ? s.panes[s.overlay.pane] : undefined));
  if (overlay?.kind !== "open" || !pane) return null;
  // mounted per open: the fields start from the pane's spec, never from an abandoned edit
  return <OpenDialog key={pane.id} pane={pane} />;
}

function OpenDialog({ pane }: { pane: S.PaneState }) {
  const list = useContexts((c) => c.list);
  const contexts = [...(list?.contexts ?? [])].sort();
  const [spec, setSpec] = useState<S.PaneSpec>(pane.spec);
  const cat = useCatalog(spec.context, true);

  // re-read on every open: contexts added to the kubeconfig meanwhile show up
  useEffect(() => {
    bridge().contexts().then((list) => useContexts.setState({ list }), () => {});
  }, []);

  const submit = (next = spec) => {
    // a cluster-scoped type has no namespace (the field is hidden for it)
    if (findResource(cat.resources, next.resource)?.namespaced === false) next = { ...next, namespace: "" };
    setUI(S.closeOverlay);
    void openSource(pane.id, next);
  };
  const field = "rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent";
  return (
    <form
      role="dialog"
      aria-label="open source"
      className="absolute top-16 left-1/2 z-30 flex w-[28rem] -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <label className="flex flex-col gap-1 text-fg-muted">
        context
        <select aria-label="context" className={field} value={spec.context} onChange={(e) => setSpec({ ...spec, context: e.target.value, namespace: S.contextNamespace(list, e.target.value) })}>
          <option value="">(current)</option>
          {contexts.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-fg-muted">
        resource
        <Combobox
          autoFocus
          label="resource"
          className={`w-full ${field}`}
          value={spec.resource}
          onChange={(resource) => setSpec({ ...spec, resource })}
          onSubmit={(resource) => submit({ ...spec, resource })}
          candidates={resourceCandidates(cat.resources)}
          hint={hint(cat, "resources")}
        />
      </label>
      {/* cluster-scoped types ignore the namespace; known only once the catalog has them */}
      {findResource(cat.resources, spec.resource)?.namespaced !== false && (
        <label className="flex flex-col gap-1 text-fg-muted">
          namespace (empty = all)
          <Combobox
            label="namespace"
            className={`w-full ${field}`}
            value={spec.namespace}
            onChange={(namespace) => setSpec({ ...spec, namespace })}
          onSubmit={(namespace) => submit({ ...spec, namespace })}
            candidates={namespaceCandidates(cat.namespaces)}
            hint={hint(cat, "namespaces")}
          />
        </label>
      )}
      <button type="submit" className="self-end rounded border border-accent px-3 py-1 text-accent">
        open ⏎
      </button>
    </form>
  );
}

/** Why completion may be incomplete; undefined when it's complete. */
function hint(cat: CatalogState, list: "resources" | "namespaces"): string | undefined {
  // say nothing until the backend has answered: the reply is usually immediate and a
  // hint shown for one frame only makes the dialog grow and shrink as it opens
  if (!cat.ready) return undefined;
  if (cat.loading) return "loading…";
  if (cat.gen === 0) return "no completion until a pane is open on this context";
  const err = cat.errors?.[list];
  if (err) return `no completion: ${err}`;
  if (list === "resources" && cat.partial) return "some API groups unavailable";
  return undefined;
}
