import { useEffect, useRef, useState } from "react";
import { applySpec } from "../commands";
import { Table } from "../grid/Table";
import type { PaneData } from "../grid/rowcache";
import { paneData, setUI, useUI } from "../store/store";
import * as S from "../store/state";

/** One split pane: header (source + filter bar), live table, status line. */
export function Pane({ id }: { id: string }) {
  const pane = useUI((s) => s.panes[id]);
  const isFocused = useUI((s) => S.activeTab(s).focused === id);
  const filterFocused = useUI((s) => isFocused && s.focus === "filter");
  const tableFocused = useUI((s) => isFocused && s.focus === "table" && !s.overlay);

  // open on mount / spec change of a pane without server pane
  useEffect(() => {
    if (pane && !pane.serverId && !pane.opening && !pane.error) void applySpec(id, pane.spec);
  }, [id, pane?.serverId, pane?.opening, pane?.error]);

  // closing happens in the store once no UI pane references the server pane (see connect)

  if (!pane) return null;
  return (
    <section
      data-pane={id}
      aria-label={`pane ${pane.spec.resource}`}
      className={`flex h-full min-h-0 w-full min-w-0 flex-col border ${isFocused ? "border-accent" : "border-border"}`}
      onMouseDown={() => setUI((s) => S.focusPane(s, id))}
    >
      <Header pane={pane} filterFocused={filterFocused} />
      <div className="relative min-h-0 flex-1">
        {pane.serverId ? (
          <Table
            serverId={pane.serverId}
            selected={pane.selected}
            focused={tableFocused}
            onSelect={(row) => setUI((s) => S.updatePane(s, id, (p) => ({ ...p, selected: row })))}
            onActivate={() => setUI((s) => S.openOverlay(S.focusPane(s, id), { kind: "detail", pane: id, key: keyAt(pane) }))}
          />
        ) : null}
        {pane.error ? <div role="alert" className="absolute inset-x-0 top-0 p-3 text-deleted">{pane.error}</div> : null}
      </div>
      <StatusLine pane={pane} />
    </section>
  );
}

function keyAt(p: S.PaneState): string | undefined {
  if (!p.serverId) return undefined;
  const d = paneData.get(p.serverId);
  return d.order[p.selected - d.offset];
}

function Header({ pane, filterFocused }: { pane: S.PaneState; filterFocused: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [grep, setGrep] = useState(pane.spec.grep);
  const [labels, setLabels] = useState(pane.spec.labelSelector);

  useEffect(() => {
    if (filterFocused) input.current?.focus();
    else input.current?.blur();
  }, [filterFocused]);

  // debounce filter → pipeline update
  useEffect(() => {
    if (grep === pane.spec.grep && labels === pane.spec.labelSelector) return;
    const t = setTimeout(() => void applySpec(pane.id, { ...pane.spec, grep, labelSelector: labels }), 150);
    return () => clearTimeout(t);
  }, [grep, labels]);

  const { context, resource, namespace } = pane.spec;
  return (
    <header className="flex items-center gap-2 border-b border-border bg-bg-elev px-2 py-1">
      <span className="text-fg-muted">{context || "(current)"}</span>
      <span className="font-semibold text-accent">{resource}</span>
      <span className="text-fg-muted">{namespace ? `-n ${namespace}` : "-A"}</span>
      <input
        ref={input}
        aria-label="filter"
        placeholder="/ grep"
        value={grep}
        onChange={(e) => setGrep(e.target.value)}
        onFocus={() => setUI((s) => ({ ...S.focusPane(s, pane.id), focus: "filter" }))}
        onBlur={() => setUI((s) => (s.focus === "filter" ? { ...s, focus: "table" } : s))}
        className="ml-auto w-48 rounded border border-border bg-bg px-2 py-0.5 text-fg outline-none focus:border-accent"
      />
      <input
        aria-label="label selector"
        placeholder="-l app=…"
        value={labels}
        onChange={(e) => setLabels(e.target.value)}
        onFocus={() => setUI((s) => ({ ...S.focusPane(s, pane.id), focus: "filter" }))}
        onBlur={() => setUI((s) => (s.focus === "filter" ? { ...s, focus: "table" } : s))}
        className="w-36 rounded border border-border bg-bg px-2 py-0.5 text-fg outline-none focus:border-accent"
      />
    </header>
  );
}

function StatusLine({ pane }: { pane: S.PaneState }) {
  const [d, setD] = useState<PaneData | undefined>(pane.serverId ? paneData.get(pane.serverId) : undefined);
  useEffect(() => {
    if (!pane.serverId) return;
    setD(paneData.get(pane.serverId));
    // status changes rarely; coarse subscription is fine here
    return paneData.subscribe(pane.serverId, (x) => setD((prev) => (prev?.status === x.status && prev?.total === x.total ? prev : x)));
  }, [pane.serverId]);
  const st = d?.status;
  return (
    <footer role="status" className="flex gap-3 border-t border-border bg-bg-elev px-2 py-0.5 text-fg-muted" aria-label="pane status">
      <span>{st?.synced ? "● live" : "○ syncing"}</span>
      <span>
        {d?.total ?? 0} shown / {st?.objects ?? 0} objects
      </span>
      {st?.error ? <span className="text-deleted">{st.error}</span> : null}
    </footer>
  );
}
