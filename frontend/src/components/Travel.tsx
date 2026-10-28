import { useEffect, useRef, useState } from "react";
import { dispatch, toggleRecording, travel } from "../commands";
import { useConfig } from "../store/config";
import { prettyKey, type CommandId } from "../keys/keymap";
import { bridge, paneData, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { ago, at as momentAt, clock, position, setTimeline, size, useTimelines } from "../store/travel";

/** The pane's status from its frames (re-renders when it changes). */
export function usePaneStatus(serverId: string | undefined) {
  const [st, setSt] = useState(serverId ? paneData.get(serverId).status : undefined);
  useEffect(() => {
    if (!serverId) return;
    setSt(paneData.get(serverId).status);
    return paneData.subscribe(serverId, (x) => setSt((prev) => (prev === x.status ? prev : x.status)));
  }, [serverId]);
  return st;
}

/** The live key of a command, for hints (keybindings.yaml may rebind it). */
export function useKey(cmd: CommandId) {
  return useConfig((c) => c.bindings.find((b) => b.command === cmd)?.key);
}

/** "⏸ 12:03:14" in the pane header while it shows the past; a click goes back to live. */
export function TravelBadge({ paneId, at, behind }: { paneId: string; at: string; behind?: number }) {
  return (
    <button
      type="button"
      aria-label="time-travel"
      title={`showing ${clock(at)} (${ago(at)})${behind ? ` · ${behind} live changes since` : ""} · click to go back to live`}
      className="shrink-0 rounded border border-accent px-1 text-accent hover:bg-bg-hover"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void travel(paneId, { live: true })}
    >
      ⏸︎ {clock(at)}
    </button>
  );
}

/**
 * Replaces the status line while the pane shows the past: the recorded span
 * as a bar, a tick per change of the pane's rows, the cursor at the moment
 * shown. A click on the bar goes there (snapped to a near change).
 */
export function TravelBar({ pane, at, behind }: { pane: S.PaneState; at: string; behind?: number }) {
  const tl = useTimelines((s) => (pane.serverId ? s.byPane[pane.serverId] : undefined));
  const bar = useRef<HTMLDivElement>(null);
  const keys = { prev: useKey("travel.prev"), next: useKey("travel.next"), back: useKey("travel.back"), live: useKey("travel.live") };
  // relative times ("4m ago") move on
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // live changes keep coming in behind: the bar's span and ticks follow (at most once a second)
  const id = pane.serverId;
  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => {
      bridge()
        .timeline(id)
        .then(
          (next) => setTimeline(id, next.at ? next : undefined),
          () => setTimeline(id, undefined),
        );
    }, tl ? 1000 : 0);
    return () => clearTimeout(t);
  }, [id, behind, at]);
  // gone from the past (back to live, recording stopped): the timeline goes
  useEffect(() => () => void (id && setTimeline(id, undefined)), [id]);
  const hint = [
    keys.prev && keys.next ? `${prettyKey(keys.prev)}/${prettyKey(keys.next)} change` : "",
    keys.back ? `${prettyKey(keys.back)} 1m` : "",
    keys.live ? `${prettyKey(keys.live)} live` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const go = (e: React.MouseEvent) => {
    const b = bar.current?.getBoundingClientRect();
    if (!tl || !b || b.width === 0) return;
    void travel(pane.id, { to: momentAt(tl, (e.clientX - b.left) / b.width, 6 / b.width) });
  };
  return (
    <footer role="status" aria-label="timeline" className="flex items-center gap-3 border-t border-accent bg-bg-elev px-2 py-0.5 text-fg-muted">
      <span className="shrink-0 text-accent">
        ⏸︎ {clock(at)} <span className="text-fg-muted">({ago(at)})</span>
      </span>
      <span className="shrink-0">{tl ? clock(tl.horizon) : ""}</span>
      <div
        ref={bar}
        role="slider"
        aria-label="moment"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={tl ? Math.round(position(tl, at) * 100) : 100}
        aria-valuetext={clock(at)}
        className="relative h-3 min-w-24 flex-1 cursor-pointer"
        onMouseDown={(e) => {
          e.preventDefault(); // the table keeps the focus
          go(e);
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
        {tl?.changes.map((c) => (
          <div key={c} data-change={c} className="absolute top-0.5 h-2 w-px bg-changed" style={{ left: `${position(tl, c) * 100}%` }} />
        ))}
        {tl ? <div aria-hidden className="absolute -top-0.5 h-4 w-0.5 -translate-x-1/2 bg-accent" style={{ left: `${position(tl, at) * 100}%` }} /> : null}
      </div>
      <span className="shrink-0">now</span>
      {behind ? <span aria-label="live changes since">+{behind} since</span> : null}
      <span className="shrink-0">{tl ? `${tl.changes.length} changes` : ""}</span>
      {tl ? (
        <span
          aria-label="history size"
          title={`recorded history of this source (all its objects, every split): ~${size(tl.bytes)} of ${size(tl.budget)}; past it the oldest changes go · history.budget in config.yaml (⌘⇧, reloads)`}
          className={`shrink-0 ${tl.bytes > tl.budget * 0.8 ? "text-changed" : ""}`}
        >
          {size(tl.bytes)} / {size(tl.budget)}
        </span>
      ) : null}
      {pane.flash ? (
        // messages show here while the timeline replaces the status line
        <span aria-label="message" className={`truncate ${pane.flash.error ? "text-deleted" : "text-fg"}`}>
          {pane.flash.text}
        </span>
      ) : (
        <span className="shrink-0">{hint}</span>
      )}
      <RecordButton paneId={pane.id} on pushRight={false} />
    </footer>
  );
}

/** ⇧H in the YAML: the field's values over time; ⏎ takes the pane to one, Esc back to the YAML. */
export function FieldList() {
  const o = useUI((s) => s.overlay);
  const list = useRef<HTMLDivElement>(null);
  const index = o?.kind === "field" ? (o.index ?? 0) : 0;
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  if (o?.kind !== "field" || !o.field) return null;
  const f = o.field;
  return (
    <div role="dialog" aria-label="field history" className="absolute inset-x-24 top-16 z-30 flex max-h-[70vh] flex-col border border-accent bg-bg-elev shadow-2xl">
      <div className="flex gap-3 border-b border-border px-3 py-1 text-fg-muted">
        <span className="font-mono text-fg">{f.path}</span>
        <span className="ml-auto">j/k · ⏎: the table then · esc: back</span>
      </div>
      <div ref={list} role="menu" aria-label="field values" className="overflow-y-auto py-1">
        {f.changes.map((c, i) => (
          <button
            key={c.at}
            type="button"
            role="menuitem"
            data-index={i}
            aria-current={i === index}
            className={`flex w-full gap-3 px-3 text-left font-mono ${i === index ? "bg-bg-hover text-fg" : "text-fg-muted"}`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setUI((x) => (x.overlay?.kind === "field" ? { ...x, overlay: { ...x.overlay, index: i } } : x))}
            onClick={() => dispatch("menu.run")}
          >
            <span className="shrink-0">{clock(c.at)}</span>
            <span className="shrink-0 text-fg-muted">{i === 0 ? "from" : ago(c.at)}</span>
            <span className={`truncate ${c.absent ? "italic" : "text-fg"}`}>{c.absent ? "(not set)" : c.value}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Record changes on/off for the pane's source (shared by its splits); off by default, it costs per event. */
export function RecordButton({ paneId, on, pushRight }: { paneId: string; on: boolean; pushRight: boolean }) {
  const key = useKey("history.toggleRecording");
  return (
    <button
      type="button"
      aria-label="record changes"
      aria-pressed={on}
      title={`${on ? "recording: diff versions ([ / ]) and time-travel (t); click to stop and drop the history" : "record changes: keep this source's changes, for diff versions ([ / ]) and time-travel (t); costs per event"}${key ? ` (${prettyKey(key)})` : ""}`}
      className={`${pushRight ? "ml-auto" : ""} shrink-0 ${on ? "text-deleted" : "hover:text-fg"}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void toggleRecording(paneId)}
    >
      <span aria-hidden>{on ? "●" : "⏸︎"}</span> {on ? "recording" : "record changes"}
    </button>
  );
}
