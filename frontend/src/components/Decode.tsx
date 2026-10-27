import { useEffect, useRef, useState } from "react";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { decodeCursor, useDiffRange, Viewer, type ContextAction, type ViewState } from "../editor/Viewer";
import { DiffNav, OverlayStatus, VersionNav } from "./Detail";
import { useKey } from "./Travel";
import { prettyKey } from "../keys/keymap";
import { dispatch, flashHere } from "../commands";
import type { Decoded } from "../transport/types";

/** The decoded value of the open decode, for window.__kw.inspect() (tests). */
export let shownDecode: Decoded | undefined;

function size(n: number) {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / (1 << 20)).toFixed(1)} MiB`;
}

/**
 * ⏎ in the detail view: the field under its cursor decoded, over it. The
 * header has the field (through the levels gone down) and the chain (a
 * click on a step leaves it and those after out); ⏎ in decoded YAML goes a
 * level deeper, Esc back up. Over the object diff it's the decoded diff:
 * the field in both versions with the same chain, [ / ] stepping versions.
 * Go decodes from the object on every request: nothing decoded is kept.
 */
export function Decode() {
  const o = useUI((s) => (s.overlay?.kind === "decode" ? s.overlay : undefined));
  const serverId = useUI((s) => (s.overlay?.kind === "decode" ? s.panes[s.overlay.pane]?.serverId : undefined));
  const [data, setData] = useState<Decoded | { error: string }>();
  const d = o?.decode;
  // per level (its path through the levels), the viewer's cursor and scroll: back from a deeper one, it's where it was
  const views = useRef(new Map<string, ViewState>());
  const bound = useKey("detail.decode");
  const key = bound ? prettyKey(bound) : "";

  // the element focused before (the detail view's editor) gets the focus back when this closes
  const open = !!o;
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus();
  }, [open]);

  useEffect(() => {
    if (!o || !d || !serverId || !o.key) return;
    let live = true;
    const paneId = o.pane;
    const refused = (why: string) => {
      // a new level that has nothing to decode on its line: back where it came from, the reason in its status line
      if (d.levels[d.levels.length - 1]!.path === undefined) {
        setUI(S.decodeUp);
        return flashHere(paneId, why, true);
      }
      setData({ error: why });
    };
    bridge()
      .decode(serverId, { key: o.key, which: d.which, to: d.version ?? 0, diff: d.diff, levels: d.levels })
      .then(
        (r) => {
          if (!live) return;
          if (r.refused) return refused(r.refused);
          shownDecode = r;
          setData(r);
          // the levels as Go resolved them (paths, chains): other versions and toggles go by those
          setUI((x) => S.decodeResolved(x, r.levels));
        },
        (e: Error) => live && setData({ error: e.message }),
      );
    return () => {
      live = false;
    };
  }, [serverId, o?.key, d?.gen]);

  // the decoded diff's versions, for [ / ] (the object diff's range comes back when it closes)
  const info = data && "text" in data ? data.diff : undefined;
  useEffect(() => {
    if (!info) return;
    const before = useDiffRange.getState().range;
    useDiffRange.setState({ range: { to: info.to, first: info.first, last: info.last } });
    return () => useDiffRange.setState({ range: before });
  }, [info?.to, info?.first, info?.last]);

  useEffect(() => {
    if (!open) {
      setData(undefined);
      shownDecode = undefined;
      views.current.clear();
    }
  }, [open]);

  if (!o || !d) return null;
  const viewOf = (k: string) => {
    let v = views.current.get(k);
    if (!v) views.current.set(k, (v = {}));
    return v;
  };
  const loaded = data && "text" in data ? data : undefined;
  const actions: ContextAction[] | undefined =
    !d.diff && loaded?.language === "yaml" ? [{ id: "kubewing.decodeDeeper", label: "decode value", key, run: () => dispatch("detail.decode") }] : undefined;
  const hints = [d.diff ? "j/k: changes" : "", d.diff && info ? "[/]: versions" : "", !d.diff && key && loaded?.language === "yaml" ? `${key}: decode deeper` : "", "w: wrap", "⌘F find", d.levels.length > 1 ? "esc: up" : "esc: back"]
    .filter(Boolean)
    .join(" · ");

  return (
    <div role="dialog" aria-label="decoded value" className="absolute inset-10 z-30 flex flex-col border border-accent bg-bg-elev shadow-2xl">
      <div className="flex items-center gap-3 whitespace-nowrap border-b border-border px-3 py-1 text-fg-muted">
        <span className="min-w-0 max-w-[45%] shrink truncate font-mono text-fg" title={loaded?.path}>
          {loaded?.path ?? "…"}
        </span>
        {loaded ? <Chain data={loaded} toggled={!!d.toggled} /> : null}
        {d.diff && info ? <VersionNav info={info} /> : null}
        {d.diff && loaded ? <DiffNav /> : null}
        <span className="ml-auto min-w-0 truncate" title={hints}>
          {hints}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {!data ? (
          <div className="p-3">decoding…</div>
        ) : "error" in data ? (
          <div className="p-3 text-deleted">{data.error}</div>
        ) : d.diff && data.prev?.error ? (
          <div className="p-3 text-deleted">the version before: {data.prev.error}</div>
        ) : d.diff && !data.prev ? (
          <div className="p-3 text-fg-muted">no version before this one to compare with ([ ] other versions)</div>
        ) : d.diff ? (
          <Viewer key="decode-diff" label="decoded diff" language={lang(data)} original={data.prev!.text} value={data.text} cursorOf={decodeCursor} />
        ) : (
          <Viewer key={levelKey(data)} label="decoded" language={lang(data)} value={data.text} contextActions={actions} cursorOf={decodeCursor} viewState={viewOf(levelKey(data))} />
        )}
      </div>
      <OverlayStatus flash={o.flash} />
    </div>
  );
}

const lang = (d: Decoded) => (d.language === "yaml" ? "yaml" : "plaintext");

/** A loaded level, by its path through the levels and how it's decoded: its viewer, and the cursor kept for it. */
const levelKey = (d: Decoded) => `decode ${d.levels.map((l) => `${JSON.stringify(l.path)}|${l.doc ?? 0}|${(l.steps ?? []).join(",")}|${l.raw ? 1 : 0}`).join(" > ")}`;

/** The chain: base64 → brotli → yaml · 14.2 KiB; a click on a step leaves it (and what follows) out, on the rendering shows the raw text. */
function Chain({ data, toggled }: { data: Decoded; toggled: boolean }) {
  const steps = data.steps ?? [];
  const last = data.levels[data.levels.length - 1];
  const reset = (e: React.MouseEvent) => {
    e.preventDefault();
    setUI(S.decodeAuto);
  };
  const toggle = (step: number | "render") => (e: React.MouseEvent) => {
    e.preventDefault(); // the editor keeps the focus
    setUI((x) => S.decodeToggle(x, data.levels, step));
  };
  const btn = "rounded px-1 font-mono hover:bg-bg-hover hover:text-fg";
  if (data.absent) return <span className="shrink-0 italic">not set in this version</span>;
  return (
    <span role="group" aria-label="decode steps" className="flex shrink-0 items-center gap-0.5">
      {steps.map((s, i) => (
        <span key={i} className="flex items-center gap-0.5">
          {i > 0 ? <span aria-hidden>→</span> : null}
          <button type="button" className={`${btn} text-fg`} title={`decode without ${s}${i < steps.length - 1 ? " and what follows" : ""}`} onMouseDown={toggle(i)}>
            {s}
          </button>
        </span>
      ))}
      {steps.length ? <span aria-hidden>→</span> : null}
      <button
        type="button"
        aria-pressed={!last?.raw}
        className={`${btn} ${last?.raw ? "line-through" : "text-accent"}`}
        title={last?.raw ? "render it again" : "show the decoded bytes as they are (the PEM text, the JWT itself)"}
        onMouseDown={toggle("render")}
      >
        {data.kind}
      </button>
      <span className="ml-1">· {size(data.size)}</span>
      {toggled ? (
        <button type="button" className={`${btn} ml-1`} title="the detected chain again" onMouseDown={reset}>
          ↺ auto
        </button>
      ) : null}
    </span>
  );
}
