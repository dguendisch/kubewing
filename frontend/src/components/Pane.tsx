import { useEffect, useRef, useState } from "react";
import { applySpec } from "../commands";
import { Table } from "../grid/Table";
import type { PaneData } from "../grid/rowcache";
import type { SafetyRule } from "../transport/types";
import { loadRule, useRules } from "../store/rules";
import { bridge, paneData, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { Terminal } from "../term/Terminal";
import { b64encode } from "../term/sessions";
import { ruleColor } from "./safetyStyle";

/** One split pane: header (source + filter bar), live table, status line. */
export function Pane({ id }: { id: string }) {
  const pane = useUI((s) => s.panes[id]);
  const isFocused = useUI((s) => S.activeTab(s).focused === id);
  const filterFocused = useUI((s) => isFocused && s.focus === "filter");
  const tableFocused = useUI((s) => isFocused && s.focus === "table" && !s.overlay);

  // open on mount / spec change of a table pane without server pane
  useEffect(() => {
    if (pane && !pane.term && !pane.serverId && !pane.opening && !pane.error) void applySpec(id, pane.spec);
  }, [id, pane?.serverId, pane?.opening, pane?.error]);
  const termFocused = useUI((s) => isFocused && s.focus === "terminal" && !s.overlay);

  // closing happens in the store once no UI pane references the server pane (see connect)

  const rule = useRules((r) => (pane?.context ? r[pane.context] : undefined));
  useEffect(() => {
    if (pane?.context) loadRule(pane.context, (c) => bridge().contextRule(c));
  }, [pane?.context, rule]);

  if (!pane) return null;
  // a labeled context colors the whole pane frame, so prod is never mistaken for dev
  const color = ruleColor(rule);
  return (
    <section
      data-pane={id}
      data-context={pane.context}
      aria-label={`pane ${pane.spec.resource}`}
      className={`flex h-full min-h-0 w-full min-w-0 flex-col ${color ? "border-2" : "border"} ${isFocused ? "border-accent" : "border-border"}`}
      style={color ? { borderColor: color } : undefined}
      onMouseDown={() => setUI((s) => S.focusPane(s, id))}
    >
      {pane.term ? (
        <>
          <TermHeader pane={pane} term={pane.term} rule={rule} />
          <div className="relative min-h-0 flex-1 bg-bg">
            <Terminal
              session={pane.term.session}
              focused={termFocused}
              onInput={(d) => void bridge().sessionInput(pane.term!.session, b64encode(d)).catch(() => {})}
              onResize={(c, r) => void bridge().sessionResize(pane.term!.session, c, r).catch(() => {})}
              onFocus={() => setUI((s) => S.focusPane(s, id))}
            />
          </div>
        </>
      ) : (
        <TablePane pane={pane} id={id} rule={rule} filterFocused={filterFocused} tableFocused={tableFocused} />
      )}
    </section>
  );
}

function TermHeader({ pane, term, rule }: { pane: S.PaneState; term: S.Term; rule?: SafetyRule }) {
  return (
    <header className="flex items-center gap-2 border-b border-border bg-bg-elev px-2 py-1">
      <Badges rule={rule} />
      <span className="text-fg-muted">{pane.context}</span>
      <span className="font-semibold text-accent">exec</span>
      <span>
        {term.pod}/{term.container}
      </span>
      {term.exited !== undefined ? (
        // only a session that never ran gets here: one that exited took its pane with it
        <span aria-label="session ended" className="ml-auto text-deleted">
          {term.exited} · ⌘W closes
        </span>
      ) : null}
    </header>
  );
}

function Badges({ rule }: { rule?: SafetyRule }) {
  return (
    <>
      {rule?.label ? (
        <span aria-label="context label" className="px-1 font-semibold text-bg" style={{ background: ruleColor(rule) ?? "var(--color-accent)" }}>
          {rule.label}
        </span>
      ) : null}
      {rule?.readOnly ? (
        <span aria-label="read-only" title="read-only context: mutations are refused" className="border border-fg-muted px-1 text-fg-muted">
          RO
        </span>
      ) : null}
    </>
  );
}

function TablePane({
  pane,
  id,
  rule,
  filterFocused,
  tableFocused,
}: {
  pane: S.PaneState;
  id: string;
  rule?: SafetyRule;
  filterFocused: boolean;
  tableFocused: boolean;
}) {
  return (
    <>
      <Header pane={pane} rule={rule} filterFocused={filterFocused} />
      <div className="relative min-h-0 flex-1">
        {pane.serverId ? (
          <Table
            serverId={pane.serverId}
            selected={pane.selected}
            focused={tableFocused}
            onSelect={(row) => setUI((s) => S.updatePane(s, id, (p) => ({ ...p, selected: row })))}
            onActivate={() => setUI((s) => S.openOverlay(S.focusPane(s, id), { kind: "detail", pane: id, key: keyAt(pane) }))}
            onContextMenu={(row, x, y) => {
              setUI((s) => S.updatePane(S.focusPane(s, id), id, (p) => ({ ...p, selected: row })));
              const key = keyAt({ ...pane, selected: row });
              if (key) setUI((s) => S.openOverlay(S.closeOverlay(s), { kind: "menu", pane: id, key, index: 0, rowIndex: row, at: { x, y } }));
            }}
          />
        ) : null}
        {pane.error ? <div role="alert" className="absolute inset-x-0 top-0 p-3 text-deleted">{pane.error}</div> : null}
      </div>
      <StatusLine pane={pane} />
    </>
  );
}

function keyAt(p: S.PaneState): string | undefined {
  if (!p.serverId) return undefined;
  const d = paneData.get(p.serverId);
  return d.order[p.selected - d.offset];
}

function Header({ pane, rule, filterFocused }: { pane: S.PaneState; rule?: SafetyRule; filterFocused: boolean }) {
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
      <Badges rule={rule} />
      <span className="text-fg-muted">{context || pane.context || "(current)"}</span>
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
      {pane.flash ? (
        <span aria-label="message" className={`ml-auto truncate ${pane.flash.error ? "text-deleted" : "text-fg"}`}>
          {pane.flash.text}
        </span>
      ) : null}
    </footer>
  );
}
