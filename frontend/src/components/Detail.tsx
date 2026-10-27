import { useEffect, useState } from "react";
import { dispatch } from "../commands";
import { useDiffNav, useDiffRange, Viewer, type ContextAction } from "../editor/Viewer";
import { prettyKey } from "../keys/keymap";
import { bridge, useUI } from "../store/store";
import { useKey, usePaneStatus } from "./Travel";
import type { DescribeResult, Detail as DetailData, DiffInfo } from "../transport/types";

/**
 * One describe call per look: StrictMode runs effects twice and a remount
 * re-runs them, but a look is (pane, row, describeGen); a second request for
 * the same look gets the same promise instead of advancing the baseline.
 */
const looks = new Map<string, Promise<DescribeResult>>();
function look(serverId: string, key: string, gen: number) {
  const id = `${serverId}|${key}|${gen}`;
  let p = looks.get(id);
  if (!p) {
    p = bridge().describe(serverId, key);
    looks.set(id, p);
    if (looks.size > 50) looks.delete(looks.keys().next().value!);
  }
  return p;
}

/** The loaded describe of the open detail view, for window.__kw.inspect() (tests). */
export let shownDescribe: DescribeResult | undefined;

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** While the object diff follows the newest version, how often it looks for a newer one. */
const followEvery = 2000;

/**
 * Detail overlay, in Monaco: full YAML, (d) diff of a version of the
 * normalized object against the one before ([ / ] older and newer, from the
 * shared watch's history; the newest by default, followed as it changes), or
 * (⇧D) kubectl describe output.
 */
export function Detail() {
  // the field history (⇧H) and a decode (⏎) open over the detail view: it stays, with its editor and cursor
  const overlay = useUI((s) => (s.overlay?.kind === "field" || s.overlay?.kind === "decode" ? s.overlay.back : s.overlay));
  const serverId = useUI((s) => (s.overlay ? s.panes[s.overlay.pane]?.serverId : undefined));
  const [data, setData] = useState<DetailData | { error: string }>();
  const [described, setDescribed] = useState<DescribeResult | { error: string }>();
  const describe = overlay?.kind === "detail" && overlay.view === "describe";
  const gen = overlay?.describeGen ?? 0;
  const version = overlay?.kind === "detail" ? overlay.version : undefined;
  const follow = overlay?.kind === "detail" && !!overlay.diff && !describe && version === undefined;

  // another row: start over; another version: keep showing the last one until it's there
  useEffect(() => setData(undefined), [overlay?.key, serverId, overlay?.kind]);
  useEffect(() => {
    if (!overlay || overlay.kind !== "detail" || !serverId || !overlay.key) return;
    let live = true;
    const key = overlay.key;
    const load = () =>
      bridge()
        .object(serverId, key, version)
        .then(
          (d) => live && setData((cur) => (cur && "yaml" in cur && same(cur, d) ? cur : d)),
          (e: Error) => live && setData({ error: e.message }),
        );
    void load();
    // the newest version moves on while the diff is open: follow it
    const t = follow ? setInterval(load, followEvery) : undefined;
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [overlay?.key, serverId, overlay?.kind, version, follow]);

  const info = data && "yaml" in data ? data.diff : undefined;
  useEffect(() => {
    useDiffRange.setState({ range: info ? { to: info.to, first: info.first, last: info.last } : undefined });
    return () => useDiffRange.setState({ range: undefined });
  }, [info?.to, info?.first, info?.last]);

  // d toggles text ↔ diff without a new look; r (describeGen) takes one
  useEffect(() => {
    setDescribed(undefined);
    if (!describe || !serverId || !overlay?.key) return;
    let live = true;
    look(serverId, overlay.key, gen).then(
      (r) => {
        if (!live) return;
        shownDescribe = r;
        setDescribed(r);
      },
      (e: Error) => live && setDescribed({ error: e.message }),
    );
    return () => void (live = false);
  }, [describe, overlay?.key, serverId, gen]);

  const st = usePaneStatus(serverId);
  const fieldKey = useKey("travel.field");
  const decodeKey = useKey("detail.decode");
  // its own message only while it's on top (a decode over it has its own)
  const flashed = useUI((s) => (s.overlay?.kind === "detail" ? s.overlay.flash : undefined));
  if (!overlay || overlay.kind !== "detail") return null;
  const diff = !!overlay.diff;
  // the field at the cursor: its values over time (needs recorded history)
  const field = !describe && st?.recording;
  const hints = [
    !describe && decodeKey ? `${prettyKey(decodeKey)}: ${diff ? "decode both sides" : "decode"}` : "",
    diff ? "j/k: changes" : "",
    diff && !describe && info ? "[/]: versions" : "",
    field && fieldKey ? `${prettyKey(fieldKey)}: field at cursor over time` : "",
    ...(describe ? ["d: diff", "r: re-run"] : ["d: diff", "⇧D: describe"]),
    "y: yaml",
    "e: edit",
    "w: wrap",
    "⌘F find",
    "esc: close",
  ]
    .filter(Boolean)
    .join(" · ");
  const decodeAction: ContextAction = { id: "kubewing.decode", label: diff ? "decode value (both versions)" : "decode value", key: decodeKey && prettyKey(decodeKey), run: () => dispatch("detail.decode") };
  const fieldActions: ContextAction[] = field
    ? [{ id: "kubewing.fieldHistory", label: "history of this field", key: fieldKey && prettyKey(fieldKey), run: () => dispatch("travel.field") }, decodeAction]
    : [decodeAction];
  return (
    <div role="dialog" aria-label="object detail" className="absolute inset-6 z-20 flex flex-col border border-accent bg-bg-elev shadow-2xl">
      {/* one line: the parts don't wrap inside; the key hints give way first (truncated, full text on hover) */}
      <div className="flex items-center gap-3 whitespace-nowrap border-b border-border px-3 py-1 text-fg-muted">
        <span className="min-w-0 max-w-[40%] shrink truncate text-fg" title={data && "name" in data ? data.name : undefined}>
          {data && "name" in data ? data.name : "…"}
        </span>
        <span className="shrink-0">
          {describe
            ? diff
              ? `describe diff (look ${described && "prevAt" in described && described.prevAt ? `${ago(described.prevAt)} ago` : "–"} → now, times ignored)`
              : "describe"
            : diff
              ? "diff (normalized)"
              : "yaml"}
        </span>
        {diff && !describe && info ? <VersionNav info={info} /> : null}
        {diff && !describe && data && "yaml" in data && !info ? (
          <span className="shrink-0" title="record history (status line, or ⇧R in the table) keeps this source's versions, within its memory budget, to step through with [ / ]">
            previous → current
          </span>
        ) : null}
        {diff ? <DiffNav /> : null}
        <span className="ml-auto min-w-0 truncate" title={hints}>
          {hints}
        </span>
      </div>
      {diff && !describe && info?.changes?.length ? <Changes changes={info.changes} /> : null}
      <div className="min-h-0 flex-1">
        {describe ? (
          !described ? (
            <div className="p-3">loading…</div>
          ) : "error" in described ? (
            <div className="p-3 text-deleted">{described.error}</div>
          ) : diff && !described.prevNorm ? (
            <div className="p-3 text-fg-muted">first describe of this object in this session: nothing to compare yet. r re-runs it; the diff then shows what changed since this look.</div>
          ) : diff ? (
            <Viewer key="describe-diff" label="describe diff" language="plaintext" original={described.prevNorm} value={described.curNorm!} />
          ) : (
            <Viewer key="describe" label="describe" language="plaintext" value={described.text} />
          )
        ) : !data ? (
          <div className="p-3">loading…</div>
        ) : "error" in data ? (
          <div className="p-3 text-deleted">{data.error}</div>
        ) : diff && !data.prevNorm ? (
          <div className="p-3 text-fg-muted">
            {!info || info.last === info.to
              ? "no previous version seen since watch start"
              : `version ${info.to} is the oldest${info.to > 1 ? " kept" : " seen since watch start"}: nothing before it to compare (] newer)`}
          </div>
        ) : diff ? (
          // one diff editor across versions: Monaco swaps the models, the scroll position stays
          <Viewer key="diff" label="diff" original={data.prevNorm} value={data.curNorm} contextActions={fieldActions} />
        ) : (
          <Viewer key="yaml" label="yaml" value={data.yaml} contextActions={fieldActions} />
        )}
      </div>
      <OverlayStatus flash={flashed} />
    </div>
  );
}

/** A detail view's or decode's status line, while it has a message (the pane's status line is covered). */
export function OverlayStatus({ flash }: { flash?: { text: string; error: boolean } }) {
  if (!flash) return null;
  return (
    <footer role="status" aria-label="overlay status" className="border-t border-border px-3 py-0.5">
      <span aria-label="message" className={`block truncate ${flash.error ? "text-deleted" : "text-fg"}`} title={flash.text}>
        {flash.text}
      </span>
    </footer>
  );
}

/** A newer response that shows the same thing keeps the old object (no Monaco reload while following). */
function same(a: DetailData, b: DetailData) {
  return a.yaml === b.yaml && a.curNorm === b.curNorm && a.prevNorm === b.prevNorm && a.diff?.to === b.diff?.to && a.diff?.first === b.diff?.first && a.diff?.last === b.diff?.last;
}

/** Older/newer version ([ / ]): which two versions are diffed, when they were seen, how many are kept. */
export function VersionNav({ info }: { info: DiffInfo }) {
  const btn = "rounded border border-border px-1.5 leading-tight text-fg enabled:hover:border-accent disabled:opacity-40";
  const go = (cmd: "diff.older" | "diff.newer") => (e: React.MouseEvent) => {
    e.preventDefault(); // the editor keeps the focus
    dispatch(cmd);
  };
  const when = (iso?: string) => (iso ? `${ago(iso)} ago` : "");
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button type="button" aria-label="older version" title="older version ([)" className={btn} disabled={info.to <= info.first} onMouseDown={go("diff.older")}>
        ‹
      </button>
      <span role="status" aria-label="diff versions" title={`versions ${info.first}–${info.last} kept`}>
        {info.from ? `v${info.from} (${when(info.fromAt)}) → v${info.to} (${when(info.toAt)})` : `v${info.to} (${when(info.toAt)})`}
        {info.to === info.last ? " · newest" : ` · ${info.last - info.to} newer`}
      </span>
      <button type="button" aria-label="newer version" title="newer version (])" className={btn} disabled={info.to >= info.last} onMouseDown={go("diff.newer")}>
        ›
      </button>
    </span>
  );
}

/** The field paths that changed, above the diff (the first few; the rest counted). */
function Changes({ changes }: { changes: string[] }) {
  const shown = changes.slice(0, 5);
  return (
    <ul aria-label="changed fields" className="border-b border-border px-3 py-0.5 font-mono text-fg-muted">
      {shown.map((c) => (
        <li key={c} className="truncate" title={c}>
          {c}
        </li>
      ))}
      {changes.length > shown.length ? <li>… {changes.length - shown.length} more</li> : null}
    </ul>
  );
}

/** Previous/next change (k/j) and where the cursor is, like VS Code's diff toolbar. */
export function DiffNav() {
  const { index, total } = useDiffNav();
  const btn = "rounded border border-border px-1.5 leading-tight text-fg enabled:hover:border-accent disabled:opacity-40";
  // mousedown + preventDefault: the editor keeps the focus, so j/k go on working
  const go = (cmd: "diff.prev" | "diff.next") => (e: React.MouseEvent) => {
    e.preventDefault();
    dispatch(cmd);
  };
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button type="button" aria-label="previous change" title="previous change (k)" className={btn} disabled={!total} onMouseDown={go("diff.prev")}>
        ↑
      </button>
      <button type="button" aria-label="next change" title="next change (j)" className={btn} disabled={!total} onMouseDown={go("diff.next")}>
        ↓
      </button>
      <span role="status" aria-label="change position">
        {total ? `${Math.max(index, 1)} / ${total}` : "no changes"}
      </span>
    </span>
  );
}
