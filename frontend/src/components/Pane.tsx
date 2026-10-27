import { useEffect, useRef, useState } from "react";
import { applySpec, moveColumn, openColumns } from "../commands";
import { RecordButton, TravelBadge, TravelBar, usePaneStatus } from "./Travel";
import { Table } from "../grid/Table";
import type { PaneData } from "../grid/rowcache";
import type { SafetyRule } from "../transport/types";
import { loadRule, useRules } from "../store/rules";
import { bridge, paneData, setUI, useUI } from "../store/store";
import { useConfig } from "../store/config";
import { prettyKey } from "../keys/keymap";
import { bottomCorners, paneIds } from "../store/layout";
import * as S from "../store/state";
import { Terminal } from "../term/Terminal";
import { FindBar } from "../term/FindBar";
import { b64encode } from "../term/sessions";
import { DraftField } from "./DraftField";
import { HistoryButtons } from "./HistoryNav";
import { Grip } from "./PaneDrag";
import { StatusError } from "./ErrorDetail";
import { liveGrep } from "./grep";
import { ruleColor } from "./safetyStyle";
import { PaneName } from "./NameField";

/** One split pane: header (source + filter bar), live table, status line. */
export function Pane({ id }: { id: string }) {
  const pane = useUI((s) => s.panes[id]);
  const isFocused = useUI((s) => S.activeTab(s).focused === id);
  // macOS rounds the window's bottom corners: a pane in one follows the curve, so its frame isn't cut off
  const corners = useUI((s) => {
    const t = s.tabs.find((x) => paneIds(x.layout).includes(id));
    const c = t && bottomCorners(t.layout, id);
    return `${c?.left ? "rounded-bl-(--kw-window-radius)" : ""} ${c?.right ? "rounded-br-(--kw-window-radius)" : ""}`;
  });
  const filterField = useUI((s) => (isFocused && s.focus === "filter" ? s.filterField ?? "grep" : undefined));
  const tableFocused = useUI((s) => isFocused && s.focus === "table" && !s.overlay);
  // ⌘⇧⏎: the other panes of the tab are hidden behind this one
  const hidden = useUI((s) => {
    const t = s.tabs.find((x) => x.maximized === id);
    return t ? paneIds(t.layout).length - 1 : 0;
  });

  // open on mount / spec change of a table pane without server pane
  useEffect(() => {
    if (pane && !pane.term && !pane.serverId && !pane.opening && !pane.error) void applySpec(id, pane.spec);
  }, [id, pane?.serverId, pane?.opening, pane?.error]);

  // back/forward through jumps: select the row that view had once the pane has it (frames only carry the window, so Go knows its index)
  const reselect = pane?.reselect;
  const serverId = pane?.serverId;
  useEffect(() => {
    if (!reselect || !serverId) return;
    const look = () =>
      void bridge()
        .rowIndex(serverId, reselect)
        .then((i) => (i >= 0 || paneData.get(serverId).status.synced) && setUI((s) => S.reselected(s, id, reselect, i)), () => {});
    look();
    return paneData.subscribe(serverId, look);
  }, [reselect, serverId]);
  const termFocused = useUI((s) => isFocused && s.focus === "terminal" && !s.overlay);
  // the terminal's find results, shown in its find bar
  const [findResult, setFindResult] = useState<{ index: number; count: number }>();

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
      className={`relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden ${corners} ${color ? "border-2" : "border"} ${isFocused ? "border-accent" : "border-border"}`}
      style={color ? { borderColor: color } : undefined}
      onMouseDown={() => setUI((s) => S.focusPane(s, id))}
    >
      <Grip id={id} />
      {hidden ? <Maximized hidden={hidden} /> : null}
      {pane.term ? (
        <>
          <TermHeader pane={pane} term={pane.term} rule={rule} />
          <div className="relative min-h-0 flex-1 bg-bg">
            <FindBar paneId={id} result={findResult} />
            <Terminal
              session={pane.term.session}
              focused={termFocused}
              find={pane.term.find}
              onFindResult={setFindResult}
              onInput={(d) => {
                if (!pane.term!.typed) setUI((s) => S.termTyped(s, id));
                void bridge().sessionInput(pane.term!.session, b64encode(d)).catch(() => {});
              }}
              onResize={(c, r) => void bridge().sessionResize(pane.term!.session, c, r).catch(() => {})}
              onFocus={() => setUI((s) => S.focusTerminal(s, id))}
            />
          </div>
        </>
      ) : (
        <TablePane pane={pane} id={id} rule={rule} filterField={filterField} tableFocused={tableFocused} />
      )}
    </section>
  );
}

/** Top right of a maximized pane: ⤡ and how many are hidden behind it (narrow, so it covers little of the header); a click shows them again. */
function Maximized({ hidden }: { hidden: number }) {
  // the live key (keybindings.yaml may rebind or unbind it)
  const key = useConfig((c) => c.bindings.find((b) => b.command === "pane.toggleMaximize")?.key);
  const others = `${hidden} other pane${hidden === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      aria-label="maximized pane"
      title={`maximized: ${others} hidden — click${key ? ` or ${prettyKey(key)}` : ""} to show all`}
      // no focus change: the pane keeps it, and keys go on to the table or shell
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onClick={() => setUI(S.toggleMaximize)}
      className="absolute top-0 right-0 z-20 flex items-center gap-0.5 rounded-bl bg-accent px-1 text-[11px] leading-4 text-bg hover:opacity-90"
    >
      <span aria-hidden>⤡</span>
      {hidden}
    </button>
  );
}

function TermHeader({ pane, term, rule }: { pane: S.PaneState; term: S.Term; rule?: SafetyRule }) {
  return (
    <header className="flex items-center gap-2 border-b border-border bg-bg-elev px-2 py-1">
      <Badges rule={rule} />
      <PaneName pane={pane} />
      <span className="text-fg-muted">{pane.context}</span>
      <span className="font-semibold text-accent">{term.ops ? "node shell" : term.debug ? "debug" : "exec"}</span>
      {term.ops ? (
        <>
          <span>{term.ops.node}</span>
          <span className="text-fg-muted">
            {term.ops.namespace}/{term.pod} · {term.ops.image}
            {term.ops.settings ? ` · ${term.ops.settings}` : ""}
          </span>
        </>
      ) : (
        <span>
          {term.pod}/{term.container}
        </span>
      )}
      {term.debug ? (
        <span className="text-fg-muted">
          {term.debug.image}
          {term.debug.target ? ` · target ${term.debug.target}` : ""}
        </span>
      ) : null}
      <NameGap paneId={pane.id} />
      {term.exited !== undefined ? (
        // only a session that failed on its own gets here: one the user ended took its pane with it
        <span aria-label="session ended" className="text-deleted">
          {/^\d+$/.test(term.exited) ? `exited ${term.exited}` : term.exited} · ⌃D closes
        </span>
      ) : null}
    </header>
  );
}

/** The header's empty stretch: a double-click there names the pane (⌘I). */
function NameGap({ paneId }: { paneId: string }) {
  return <span aria-hidden className="flex-1 self-stretch" onDoubleClick={() => setUI((s) => S.renamePane(s, paneId))} />;
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
  filterField,
  tableFocused,
}: {
  pane: S.PaneState;
  id: string;
  rule?: SafetyRule;
  filterField?: S.FilterField;
  tableFocused: boolean;
}) {
  return (
    <>
      <Header pane={pane} rule={rule} filterField={filterField} />
      <div className="relative min-h-0 flex-1">
        {pane.serverId ? (
          <Table
            serverId={pane.serverId}
            grep={pane.spec.grep}
            selected={pane.selected}
            focused={tableFocused}
            type={pane.type}
            onHeaderMenu={() => void openColumns(id)}
            onColumnMoved={(from, to) => void moveColumn(id, from, to)}
            sort={S.sortOf(pane.spec.sort)}
            onSort={(column) => void applySpec(id, { ...pane.spec, sort: S.nextSort(pane.spec.sort, column) })}
            onSelect={(row) => setUI((s) => S.updatePane(s, id, (p) => ({ ...p, selected: row })))}
            onContextMenu={(row, x, y, column) => {
              setUI((s) => S.updatePane(S.focusPane(s, id), id, (p) => ({ ...p, selected: row })));
              const key = keyAt({ ...pane, selected: row });
              if (key) setUI((s) => S.openOverlay(S.closeOverlay(s), { kind: "menu", pane: id, key, index: 0, rowIndex: row, at: { x, y }, column }));
            }}
          />
        ) : null}
        {pane.error ? <div role="alert" className="absolute inset-x-0 top-0 p-3 text-deleted">{pane.error}</div> : null}
      </div>
      <PaneFooter pane={pane} />
    </>
  );
}

/** Opens the column dialog (same as o); shows its key, which keybindings.yaml may change. */
function ColumnsButton({ paneId, pushRight }: { paneId: string; pushRight: boolean }) {
  const key = useConfig((c) => c.bindings.find((b) => b.command === "view.columns")?.key);
  return (
    <button
      type="button"
      aria-label="columns"
      title={`columns: -o wide, custom ones${key ? ` (${prettyKey(key)})` : ""}`}
      className={`${pushRight ? "ml-auto" : ""} shrink-0 hover:text-fg`}
      // keeps the focus where it is: the dialog restores it on close
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void openColumns(paneId)}
    >
      <span aria-hidden>▥</span> columns
    </button>
  );
}

function keyAt(p: S.PaneState): string | undefined {
  if (!p.serverId) return undefined;
  const d = paneData.get(p.serverId);
  return d.order[p.selected - d.offset];
}

function Header({ pane, rule, filterField }: { pane: S.PaneState; rule?: SafetyRule; filterField?: S.FilterField }) {
  const input = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const celInput = useRef<HTMLInputElement>(null);
  const [grep, setGrep] = useState(pane.spec.grep);
  const fields = [input, labelInput, celInput];

  // "filter" focus covers all fields: `/` lands in grep, `l` in labels, `c` in CEL; a click sets the field it lands in
  useEffect(() => {
    const active = document.activeElement;
    const target = { grep: input, labels: labelInput, cel: celInput }[filterField ?? "grep"].current;
    if (filterField && target && active !== target) target.focus();
    else if (!filterField && fields.some((f) => f.current === active)) (active as HTMLElement).blur();
  }, [filterField]);
  // moving between the fields stays in "filter"
  const onBlur = (e: React.FocusEvent) => {
    if (fields.some((f) => f.current === e.relatedTarget)) return;
    setUI((s) => (s.focus === "filter" ? { ...s, focus: "table" } : s));
  };
  const focus = (f: S.FilterField) => () => setUI((s) => ({ ...S.focusPane(s, pane.id), focus: "filter", filterField: f }));

  // grep applies live (debounced), except a negated term still being typed:
  // that one waits for a space, ⏎ or leaving the field (see liveGrep)
  const [complete, setComplete] = useState(false);
  const live = liveGrep(grep);
  const held = live.pendingFrom >= 0 && !complete ? grep.slice(live.pendingFrom) : "";
  const grepNow = held ? live.apply : grep;
  useEffect(() => {
    if (grepNow === pane.spec.grep) return;
    const t = setTimeout(() => apply({ grep: grepNow }), 150);
    return () => clearTimeout(t);
  }, [grepNow]);
  // a jump or going back replaces the spec: the field follows
  useEffect(() => setGrep(pane.spec.grep), [pane.spec.grep]);
  // the latest spec, for applies that land after other edits
  const apply = (patch: Partial<S.PaneSpec>) => {
    const cur = useUI.getState().panes[pane.id];
    if (cur) void applySpec(pane.id, { ...cur.spec, ...patch });
  };

  const field = "rounded border border-border bg-bg px-2 py-0.5 text-fg outline-none focus:border-accent";
  const { context, resource, namespace, fieldSelector } = pane.spec;
  const st = usePaneStatus(pane.serverId);
  return (
    <header className={`flex items-center gap-2 border-b bg-bg-elev px-2 py-1 ${st?.at ? "border-accent" : "border-border"}`}>
      <HistoryButtons pane={pane} />
      <Badges rule={rule} />
      {st?.at ? <TravelBadge paneId={pane.id} at={st.at} behind={st.behind} /> : null}
      <PaneName pane={pane} />
      <span className="shrink-0 text-fg-muted" title={S.splitCluster(context).kubeconfig ? "from a terminal's own kubeconfig (⌘O lists its contexts)" : undefined}>
        {S.splitCluster(context).context || pane.context || "(current)"}
      </span>
      <span className="shrink-0 font-semibold text-accent">{resource}</span>
      <span className="shrink-0 text-fg-muted">{namespace ? `-n ${namespace}` : "-A"}</span>
      {fieldSelector ? (
        <span aria-label="field selector" title="field selector (from a jump)" className="truncate border border-border px-1 text-fg-muted">
          {fieldSelector}
        </span>
      ) : null}
      <NameGap paneId={pane.id} />
      <div className="relative">
        <input
          ref={input}
          aria-label="filter"
          placeholder="/ grep"
          title={'terms must all match · !x excludes · "a b" is one term'}
          value={grep}
          onChange={(e) => {
            setGrep(e.target.value);
            setComplete(false);
          }}
          onKeyDown={(e) => {
            // ⏎ applies and goes back to the list, like esc
            if (e.key === "Enter") {
              setComplete(true);
              setUI((s) => (s.focus === "filter" ? { ...s, focus: "table" } : s));
            }
          }}
          onFocus={focus("grep")}
          onBlur={(e) => {
            setComplete(true);
            onBlur(e);
          }}
          className={`w-48 ${field} ${held ? "border-dashed" : ""}`}
        />
        {/* same drop-down hint as the label and CEL drafts */}
        {held && filterField === "grep" ? (
          <div role="status" aria-label="grep draft" className="absolute top-full right-0 z-30 mt-px whitespace-nowrap border border-border bg-bg-elev px-1 text-fg-muted">
            {held} · ⏎ apply
          </div>
        ) : null}
      </div>
      <DraftField
        ref={labelInput}
        field="labels"
        label="label selector"
        placeholder="l labels"
        applied={pane.spec.labelSelector}
        serverId={pane.serverId}
        focused={filterField === "labels"}
        onApply={(labelSelector) => apply({ labelSelector })}
        onFocus={focus("labels")}
        onBlur={onBlur}
        className={`w-36 ${field}`}
      />
      <DraftField
        ref={celInput}
        field="filter"
        label="cel"
        placeholder="c cel"
        applied={pane.spec.filter}
        serverId={pane.serverId}
        focused={filterField === "cel"}
        onApply={(filter) => apply({ filter })}
        onFocus={focus("cel")}
        onBlur={onBlur}
        className={`w-36 truncate ${field}`}
      />
      {/* other kinds aren't affected, so there's nothing to show */}
      {S.hasHealth(pane.kind) ? (
        <label title={healthyTitle(pane.kind!)} className="flex shrink-0 cursor-pointer items-center gap-1 text-fg-muted">
          <input
            type="checkbox"
            aria-label="hide healthy"
            checked={!!pane.spec.hideHealthy}
            onChange={(e) => apply({ hideHealthy: e.target.checked })}
            // a click mustn't leave focus in the header: keys go back to the table
            onMouseUp={(e) => e.currentTarget.blur()}
            className="accent-(--color-accent)"
          />
          hide healthy
        </label>
      ) : null}
    </header>
  );
}

function healthyTitle(kind: string) {
  const what =
    kind === "Pod"
      ? "pods that are Running with all containers ready"
      : `${kind.toLowerCase()}s whose replicas are all current, up to date, ready and available`;
  return `hide ${what} (h)`;
}

/** The not-yet-synced marker: connected's dot, pulsing while the initial list loads; a still ring once the
 *  source reports an error, since the error beside it is then the news. */
function Syncing({ stalled }: { stalled: boolean }) {
  return (
    <span>
      {stalled ? "○" : <span className="text-accent motion-safe:animate-pulse">●</span>} syncing
    </span>
  );
}

/** While the pane shows the past the timeline replaces the status line. */
function PaneFooter({ pane }: { pane: S.PaneState }) {
  const st = usePaneStatus(pane.serverId);
  return st?.at ? <TravelBar pane={pane} at={st.at} behind={st.behind} /> : <StatusLine pane={pane} />;
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
      {st?.synced ? (
        <span>
          <span className="text-connected">●</span> connected
        </span>
      ) : (
        <Syncing stalled={!!st?.error} />
      )}
      <span>
        {d?.total ?? 0} shown / {st?.objects ?? 0} objects
      </span>
      {st?.error ? <StatusError paneId={pane.id} which="source" text={st.error} /> : null}
      {st?.filterErrors ? <StatusError paneId={pane.id} which="filter" text={st.filterError ?? ""} prefix={`filter failed on ${st.filterErrors}: `} /> : null}
      {pane.flash ? (
        <span aria-label="message" className={`ml-auto truncate ${pane.flash.error ? "text-deleted" : "text-fg"}`}>
          {pane.flash.text}
        </span>
      ) : null}
      <RecordButton paneId={pane.id} on={!!st?.recording} pushRight={!pane.flash} />
      {pane.type ? <ColumnsButton paneId={pane.id} pushRight={false} /> : null}
    </footer>
  );
}
