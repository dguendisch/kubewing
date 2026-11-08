import { useEffect, useRef, useState } from "react";
import { submitColumns } from "../commands";
import { Combobox } from "../complete/Combobox";
import { Suggestions, useFieldCompletion } from "../complete/useFieldCompletion";
import { bridge, setUI, useColumns, useUI } from "../store/store";
import * as S from "../store/state";
import type { ColumnChoices, ColumnType, FieldKeys, MetricsPlace } from "../transport/types";
import { addColumn, emptyColumn, initialColumns, isCustom, isWide, metricsOn, move, moveTo, pathCandidates, pathContext, remove, resetColumns, toConfig, toggle, toggleMetrics, toggleWide, wideOn, type ColumnRow, type MetricGroup, type NewColumn } from "./columnsForm";

/**
 * o (or a right-click on the header): the pane's columns, kept per resource
 * type (all panes of it, all clusters; columns.yaml). Every server column is
 * listed, -o wide ones too (the wide switch shows or hides those at once),
 * pods' and nodes' metric columns (kubectl top) as well (the metrics switch),
 * and custom ones can be added by field path or CEL (both completed from
 * the pane's live objects). In the list ↑/↓ move,
 * space shows/hides, ⌥↑/⌥↓ (or drag & drop) reorder, ⌫ removes a custom column; ⏎ saves
 * (from anywhere but the add fields), Esc cancels.
 */
export function ColumnsDialog() {
  const o = useUI((s) => (s.overlay?.kind === "columns" ? s.overlay : undefined));
  const pane = useUI((s) => (s.overlay?.kind === "columns" ? s.panes[s.overlay.pane] : undefined));
  if (!o?.columns || !pane?.serverId || !pane.type) return null;
  return <Dialog key={`${o.pane}/${pane.serverId}`} serverId={pane.serverId} type={pane.type} choices={o.columns} />;
}

const types: { value: ColumnType; label: string }[] = [
  { value: "", label: "text" },
  { value: "number", label: "number" },
  { value: "bytes", label: "bytes" },
  { value: "age", label: "age" },
];

/** The drop line on the row a dragged one lands on: above it when moving up, below when moving down. */
function dropLine(drag: { from: number; over: number } | undefined, i: number): string {
  if (!drag || drag.over !== i || drag.from === i) return "";
  return drag.from > i ? "border-t-accent" : "border-b-accent";
}

function Dialog({ serverId, type, choices }: { serverId: string; type: string; choices: ColumnChoices }) {
  const [rows, setRows] = useState<ColumnRow[]>(() => initialColumns(choices.options));
  const [at, setAt] = useState(0);
  const [add, setAdd] = useState<NewColumn>(emptyColumn);
  const [error, setError] = useState<string>();
  const hasWidths = useColumns((c) => Object.keys(c.types[type]?.widths ?? {}).length > 0);
  // per metric group: where its columns go when switched on, where they were when switched off (saved with OK)
  const [places, setPlaces] = useState<Partial<Record<MetricGroup, MetricsPlace | undefined>>>(() => ({ usage: useColumns.getState().types[type]?.metrics, alloc: useColumns.getState().types[type]?.allocation }));
  const [switched, setSwitched] = useState<MetricGroup[]>([]);
  const list = useRef<HTMLUListElement>(null);
  const hasWide = rows.some(isWide);
  const has = (g: MetricGroup) => rows.some((r) => r.metric === g);
  const [drag, setDrag] = useState<{ from: number; over: number }>();

  // CEL completion, as in the filter bar's CEL field
  const celInput = useRef<HTMLInputElement>(null);
  const [celFocused, setCelFocused] = useState(false);
  const cel = useFieldCompletion({ input: celInput, value: add.value, setValue: (value) => setAdd((a) => ({ ...a, value })), serverId, enabled: add.mode === "expr" && celFocused });

  // field path completion, one segment at a time from the pane's live objects
  const keys = useRef(new Map<string, Promise<FieldKeys>>());
  // with the parent they're for: a step into a key (spec.) shows none until its own keys are there, not the old ones under the new path
  const [fieldKeys, setFieldKeys] = useState<{ parent: string; keys?: FieldKeys }>();
  const parent = add.mode === "path" ? pathContext(add.value).parent.join("\0") : undefined;
  useEffect(() => {
    if (parent === undefined) return;
    let p = keys.current.get(parent);
    if (!p) keys.current.set(parent, (p = bridge().fieldKeys(serverId, parent ? parent.split("\0") : [])));
    let live = true;
    p.then((keys) => live && setFieldKeys({ parent, keys }), () => live && setFieldKeys({ parent }));
    return () => void (live = false);
  }, [serverId, parent]);

  const update = (next: ColumnRow[], focus = at) => {
    setRows(next);
    setError(undefined);
    setAt(Math.max(0, Math.min(focus, next.length - 1)));
  };
  // the keyboard starts in the list (autoFocus only works on form fields, not on a list item)
  useEffect(() => list.current?.querySelector("li")?.focus(), []);
  // a removed row (⌫, ✕) takes the focus with it: the list gets it back, on the row now at its place
  const refocus = useRef(false);
  useEffect(() => {
    // the list follows the focused row (keyboard)
    if (refocus.current || list.current?.contains(document.activeElement)) list.current?.querySelectorAll("li")[at]?.focus();
    refocus.current = false;
  }, [at, rows]);

  const save = () =>
    void submitColumns(type, toConfig(rows, choices.defaults), Object.fromEntries(switched.map((g) => [g, places[g] ?? null]))).then((err) => err && setError(err));
  const switchMetrics = (g: MetricGroup) => {
    const t = toggleMetrics(rows, g, places[g]);
    // off: where they were; on: the place is used (off again in the dialog takes the new one)
    setPlaces({ ...places, [g]: t.place });
    if (!switched.includes(g)) setSwitched([...switched, g]);
    update(t.rows);
  };
  const submitAdd = (value = add.value) => {
    const r = addColumn(rows, { ...add, value });
    if ("error" in r) return setError(r.error);
    update(r.rows, r.rows.findIndex((x) => x.name === (add.name.trim() || r.rows.find((y) => !rows.includes(y))?.name)));
    setAdd({ ...emptyColumn, mode: add.mode });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      const d = k === "ArrowDown" ? 1 : -1;
      if (e.altKey) update(move(rows, at, d), at + d);
      else setAt(Math.max(0, Math.min(at + d, rows.length - 1)));
    } else if (k === "Enter") {
      // a list item isn't a form field: ⏎ doesn't submit by itself
      e.preventDefault();
      save();
    } else if (k === " ") {
      e.preventDefault();
      update(toggle(rows, at));
    } else if ((k === "Backspace" || k === "Delete") && rows[at] && isCustom(rows[at])) {
      e.preventDefault();
      refocus.current = true;
      update(remove(rows, at));
    }
  };

  const field = "rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent";
  const button = "rounded border border-border px-2 py-0.5 text-fg-muted hover:border-accent hover:text-fg";

  return (
    <form
      role="dialog"
      aria-label="columns"
      className="absolute top-16 left-1/2 z-30 flex max-h-[80vh] w-[40rem] -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-dialog"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <div className="flex items-center gap-2 text-fg">
        <span>
          columns of <span className="font-semibold">{type}</span>
        </span>
        <span className="text-fg-muted">· all panes and clusters</span>
        <span className="flex-1" />
        {has("usage") ? (
          <label className="flex items-center gap-1 text-fg-muted" title="CPU and memory usage (kubectl top), polled while shown">
            <input type="checkbox" aria-label="metrics" checked={metricsOn(rows, "usage")} onChange={() => switchMetrics("usage")} />
            metrics
          </label>
        ) : null}
        {has("alloc") ? (
          <label className="flex items-center gap-1 text-fg-muted" title="what the pods on each node request and are limited to (kubectl describe node); lists all pods first">
            <input type="checkbox" aria-label="requests/limits" checked={metricsOn(rows, "alloc")} onChange={() => switchMetrics("alloc")} />
            requests/limits
          </label>
        ) : null}
        {hasWide ? (
          <label className="flex items-center gap-1 text-fg-muted" title="all -o wide columns">
            <input type="checkbox" aria-label="wide" checked={wideOn(rows)} onChange={() => update(toggleWide(rows))} />
            -o wide
          </label>
        ) : null}
      </div>
      <ul ref={list} role="listbox" aria-label="columns" className="min-h-0 flex-1 overflow-auto border border-border" onKeyDown={onListKey}>
        {rows.map((r, i) => (
          <li
            key={r.name}
            role="option"
            aria-selected={i === at}
            aria-checked={r.shown}
            tabIndex={i === at ? 0 : -1}
            onFocus={() => setAt(i)}
            // drag & drop reorders; the accent line shows where it lands
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", r.name);
              setDrag({ from: i, over: i });
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              if (drag.over !== i) setDrag({ ...drag, over: i });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag) update(moveTo(rows, drag.from, i), i);
              setDrag(undefined);
            }}
            onDragEnd={() => setDrag(undefined)}
            className={`flex cursor-grab items-center gap-2 border-y-2 border-transparent px-2 py-0.5 outline-none ${i === at ? "bg-bg-hover" : ""} ${drag?.from === i ? "opacity-50" : ""} ${dropLine(drag, i)}`}
          >
            <span aria-hidden className="text-fg-muted">⠿</span>
            <input type="checkbox" tabIndex={-1} aria-label={r.name} checked={r.shown} onChange={() => update(toggle(rows, i), i)} />
            <span className={r.shown ? "text-fg" : "text-fg-muted"}>{r.name}</span>
            {isWide(r) ? <span className="rounded bg-bg px-1 text-[10px] text-fg-muted">wide</span> : null}
            {r.metric ? <span className="rounded bg-bg px-1 text-[10px] text-fg-muted">{r.metric === "usage" ? "metrics" : "requests/limits"}</span> : null}
            {r.missing ? <span className="rounded bg-bg px-1 text-[10px] text-deleted" title="this resource has no such server column">missing</span> : null}
            {isCustom(r) ? <span className="truncate text-[11px] text-fg-muted">{r.path ?? r.expr}</span> : null}
            <span className="flex-1" />
            {isCustom(r) ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={`remove ${r.name}`}
                className="text-fg-muted hover:text-deleted"
                onClick={() => {
                  refocus.current = true;
                  update(remove(rows, i), i);
                }}
              >
                ✕
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <fieldset
        className="flex flex-col gap-1 border border-border p-2 text-fg-muted"
        // ⏎ in the add fields adds the column instead of saving; with nothing typed (e.g. right after adding one) it saves
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.defaultPrevented) {
            e.preventDefault();
            if (add.value.trim()) submitAdd();
            else save();
          }
        }}
      >
        <legend className="px-1">add a column</legend>
        <div className="flex gap-2">
          <input aria-label="column name" className={`w-24 ${field}`} placeholder="name" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
          <select aria-label="column source" className={field} value={add.mode} onChange={(e) => setAdd({ ...add, mode: e.target.value as NewColumn["mode"] })}>
            <option value="path">path</option>
            <option value="expr">CEL</option>
          </select>
          {/* both fields take the row's free width: Combobox puts className on its input, so the box is the flex item */}
          {add.mode === "path" ? (
            <div className="min-w-0 flex-1">
              <Combobox
                label="column path"
                value={add.value}
                onChange={(value) => setAdd({ ...add, value })}
                enterAccepts
                continues={(v) => v.endsWith(".")}
                onSubmit={(value) => (value.trim() ? submitAdd(value) : save())}
                candidates={pathCandidates(add.value, fieldKeys && fieldKeys.parent === parent ? fieldKeys.keys : undefined)}
                placeholder="e.g. spec.nodeName"
                className={`w-full ${field}`}
              />
            </div>
          ) : (
            <div className="relative min-w-0 flex-1">
              <input
                ref={celInput}
                aria-label="column expression"
                aria-autocomplete="list"
                aria-expanded={!!cel.list}
                autoComplete="off"
                spellCheck={false}
                className={`w-full ${field}`}
                placeholder='e.g. o.metadata.labels["app"]'
                value={add.value}
                onChange={(e) => {
                  setAdd({ ...add, value: e.target.value });
                  cel.trackCaret(e.target);
                }}
                onSelect={(e) => cel.trackCaret(e.currentTarget)}
                onKeyDown={(e) => void cel.onKeyDown(e)}
                onFocus={() => setCelFocused(true)}
                onBlur={() => {
                  setCelFocused(false);
                  cel.close();
                }}
              />
              {cel.list ? <Suggestions list={cel.list} accept={cel.accept} label="cel suggestions" /> : null}
            </div>
          )}
          <select aria-label="column type" className={field} value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value as ColumnType })}>
            {types.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="text-[11px]">{add.mode === "path" ? "keys with dots (labels, annotations) need CEL" : "CEL over o, the object · ⇥ completes"}</div>
      </fieldset>
      {error ? (
        <div role="alert" className="text-deleted">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="button" className={button} onClick={() => update(resetColumns(rows, choices.defaults), 0)}>
          reset columns
        </button>
        <button type="button" className={button} disabled={!hasWidths} onClick={() => void bridge().setColumnWidths(type, null).catch((e) => setError(String(e?.message ?? e)))}>
          reset widths
        </button>
        <span className="flex-1" />
        <button type="button" className={button} onClick={() => setUI(S.closeOverlay)}>
          cancel
        </button>
        <button type="submit" className="rounded border border-accent px-3 py-0.5 text-accent outline-none hover:bg-accent/15 focus:bg-accent/15">
          OK
        </button>
      </div>
      <div className="text-[11px] text-fg-muted">space show · drag or ⌥↑↓ move · ⏎ save · esc cancel</div>
    </form>
  );
}
