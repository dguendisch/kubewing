import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { dispatch, flash } from "../commands";
import { Editor } from "../editor/Editor";
import { setDiffRange, useDiffNavOf, viewSlot, Viewer, type ContextAction, type ViewState } from "../editor/Viewer";
import { prettyKey } from "../keys/keymap";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { HistoryButtons } from "./HistoryNav";
import { PaneName } from "./NameField";
import { Badges, ResourceName } from "./Pane";
import { useKey, usePaneStatus } from "./Travel";
import type { DescribeResult, Decoded, Detail as DetailData, DiffInfo, SafetyRule } from "../transport/types";

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

/** Per pane: the describe and the decoded value shown, for window.__kw.inspect() (tests). */
export const shownDescribe = new Map<string, DescribeResult>();
export const shownDecode = new Map<string, Decoded>();

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** While the object diff follows the newest version, how often it looks for a newer one. */
const followEvery = 2000;

/**
 * A pane's object view, in Monaco: the full YAML, (d) the diff of a version
 * of the normalized object against the one before ([ / ] older and newer,
 * from the shared watch's history; the newest by default, followed as it
 * changes), or (⇧D) kubectl describe output. ⏎ decodes the value under the
 * cursor in place (a breadcrumb above it, Esc back up); e edits the object
 * in place. Over the table (⏎) or in a split of its own (⇧⏎), which can
 * follow the table's selection.
 */
export function ObjectPane({ pane, rule, focused }: { pane: S.PaneState; rule?: SafetyRule; focused: boolean }) {
  const o = pane.object!;
  return (
    <>
      <ObjectHeader pane={pane} o={o} rule={rule} />
      {o.edit ? (
        <EditView pane={pane} e={o.edit} focused={focused} />
      ) : (
        <>
          {/* the object stays mounted under a decoded value: back up, its cursor and scroll are where they were */}
          <div className={`${o.decode ? "hidden" : "flex"} min-h-0 flex-1 flex-col`}>
            <DetailView pane={pane} o={o} focused={focused && !o.decode} />
          </div>
          {o.decode ? <DecodeView pane={pane} o={o} d={o.decode} focused={focused} /> : null}
        </>
      )}
      <ObjectStatus pane={pane} />
    </>
  );
}

/** The pane's message (an action's result, why a decode was refused), in its status line. */
function ObjectStatus({ pane }: { pane: S.PaneState }) {
  if (!pane.flash) return null;
  return (
    <footer role="status" aria-label="object status" className="border-t border-border bg-bg-elev px-2 py-0.5">
      <span aria-label="message" className={`block truncate ${pane.flash.error ? "text-deleted" : "text-fg"}`} title={pane.flash.text}>
        {pane.flash.text}
      </span>
    </footer>
  );
}

/** Context badges, what's shown (the object, the decoded path), the follow checkbox. */
function ObjectHeader({ pane, o, rule }: { pane: S.PaneState; o: S.ObjectView; rule?: SafetyRule }) {
  const blocked = useUI((s) => S.followBlocked(s, pane));
  const title = o.title ?? "…";
  return (
    <header className="flex items-center gap-2 whitespace-nowrap border-b border-border bg-bg-elev px-2 py-1">
      {o.split ? null : <HistoryButtons pane={pane} />}
      <Badges rule={rule} />
      <PaneName pane={pane} />
      <span className="shrink-0 text-fg-muted">{pane.context}</span>
      <ResourceName pane={pane} />
      <Breadcrumb pane={pane} o={o} title={title} />
      {o.split ? <FollowBox paneId={pane.id} on={!!o.follow} blocked={o.edit ? "while editing" : blocked} off={o.followOff} /> : null}
      {S.unsaved(pane) ? (
        <span aria-label="unsaved changes" title="unsaved changes in the editor" className="shrink-0 text-changed">
          ● unsaved
        </span>
      ) : null}
    </header>
  );
}

/**
 * Where the view is: the object, then each decoded level's path. A click on
 * the object (or a level) goes back up to it, as Esc does level by level.
 */
function Breadcrumb({ pane, o, title }: { pane: S.PaneState; o: S.ObjectView; title: string }) {
  const paths = useDecodePaths(pane.id);
  const levels = o.decode?.levels ?? [];
  const up = (to: number) => (e: React.MouseEvent) => {
    e.preventDefault(); // the viewer keeps the focus
    setUI((s) => {
      let x = S.focusPane(s, pane.id);
      // up to level `to` (-1: the object)
      for (let n = (x.panes[pane.id]?.object?.decode?.levels.length ?? 0) - 1; n > to; n--) x = S.decodeUp(x, pane.id);
      return x;
    });
  };
  const crumb = "min-w-0 truncate rounded px-1 font-mono hover:bg-bg-hover hover:text-fg";
  return (
    <nav aria-label="object path" className="flex min-w-0 shrink items-center gap-0.5 text-fg-muted">
      <button type="button" className={`${crumb} ${levels.length ? "" : "text-fg"}`} title={levels.length ? "back to the object (esc goes up a level)" : title} onMouseDown={up(-1)}>
        {title}
      </button>
      {levels.map((l, i) => (
        <span key={i} className="flex min-w-0 items-center gap-0.5">
          <span aria-hidden>›</span>
          <button type="button" className={`${crumb} ${i === levels.length - 1 ? "text-fg" : ""}`} title={paths[i]?.full ?? `line ${l.line + 1}`} onMouseDown={up(i)}>
            {paths[i]?.path ?? "…"}
          </button>
        </span>
      ))}
    </nav>
  );
}

/** Per pane: each decoded level's own path ("data.kubeconfig") and the full one (through the levels), from the decoded answers. */
type Crumb = { path: string; full: string };
const useCrumbs = create<Record<string, Crumb[]>>(() => ({}));
function setDecodePath(paneId: string, level: number, path: string, full: string) {
  useCrumbs.setState((s) => {
    const list = (s[paneId] ?? []).slice(0, level);
    list[level] = { path, full };
    return { ...s, [paneId]: list };
  });
}
const none: Crumb[] = [];
const useDecodePaths = (paneId: string): Crumb[] => useCrumbs((s) => s[paneId] ?? none);

/** The split's "follow" checkbox: on, it shows the table's selected row as it moves. */
function FollowBox({ paneId, on, blocked, off }: { paneId: string; on: boolean; blocked?: string; off?: string }) {
  const title = blocked
    ? `can't follow: ${blocked}`
    : on
      ? "shows the row selected in the table it came from, as the selection moves; off: stays on this object"
      : off
        ? `stopped following: ${off}`
        : "follow the table's selection: show whichever row is selected there";
  return (
    <label title={title} className={`ml-auto flex shrink-0 items-center gap-1 ${blocked ? "text-fg-muted opacity-50" : "cursor-pointer text-fg-muted"}`}>
      <input
        type="checkbox"
        aria-label="follow selection"
        checked={on}
        disabled={!!blocked && !on}
        onChange={(e) => setUI((s) => S.setFollow(S.focusPane(s, paneId), paneId, e.target.checked))}
        // a click mustn't leave focus on the checkbox: keys go back to the viewer
        onMouseUp={(e) => e.currentTarget.blur()}
        className="accent-(--color-accent)"
      />
      follow
      {off && !on ? <span className="text-changed">· {off}</span> : null}
    </label>
  );
}

/** The object: YAML, its diff, or describe (and describe's diff). */
function DetailView({ pane, o, focused }: { pane: S.PaneState; o: S.ObjectView; focused: boolean }) {
  const serverId = pane.serverId;
  const [data, setData] = useState<DetailData | { error: string }>();
  const [described, setDescribed] = useState<DescribeResult | { error: string }>();
  const describe = o.view === "describe";
  const gen = o.describeGen ?? 0;
  const version = o.version;
  const follow = !!o.diff && !describe && version === undefined;
  const key = o.key;

  // another source: start over; another row (following) or version: keep showing the last one until it's there
  useEffect(() => setData(undefined), [serverId]);
  useEffect(() => {
    if (!serverId || describe) return;
    let live = true;
    const load = () =>
      bridge()
        .object(serverId, key, version)
        .then(
          (d) => {
            if (!live) return;
            setData((cur) => (cur && "yaml" in cur && same(cur, d) ? cur : d));
            // the tab and the history list name the object
            setUI((s) => (s.panes[pane.id]?.object?.key === key && s.panes[pane.id]?.object?.title !== d.name ? S.setObject(s, pane.id, (x) => ({ ...x, title: d.name })) : s));
          },
          // a row gone meanwhile (deleted while followed): its last state stays, with why
          (e: Error) => live && setData((cur) => (cur && "yaml" in cur && cur.key === key ? cur : { error: e.message })),
        );
    void load();
    // the newest version moves on while the diff is open (the YAML too): follow it
    const t = follow || !o.diff ? setInterval(load, followEvery) : undefined;
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key, serverId, version, follow, describe, !!o.diff]);

  const info = data && "yaml" in data && o.diff ? data.diff : undefined;
  useEffect(() => {
    setDiffRange(pane.id, info ? { to: info.to, first: info.first, last: info.last } : undefined);
    return () => setDiffRange(pane.id, undefined);
  }, [pane.id, info?.to, info?.first, info?.last]);
  // the loaded object is another one than asked for (following moved on): it's on its way
  const stale = data && "yaml" in data && data.key !== key;

  // d toggles text ↔ diff without a new look; r (describeGen) takes one
  useEffect(() => {
    setDescribed(undefined);
    if (!describe || !serverId) return;
    let live = true;
    look(serverId, key, gen).then(
      (r) => {
        if (!live) return;
        shownDescribe.set(pane.id, r);
        setDescribed(r);
      },
      (e: Error) => live && setDescribed({ error: e.message }),
    );
    return () => {
      live = false;
      shownDescribe.delete(pane.id);
    };
  }, [describe, key, serverId, gen]);

  const st = usePaneStatus(serverId);
  const fieldKey = useKey("travel.field");
  const decodeKey = useKey("detail.decode");
  const diff = !!o.diff;
  // the field at the cursor: its values over time (needs recorded history)
  const field = !describe && st?.recording;
  const hints = [
    !describe && decodeKey ? `${prettyKey(decodeKey)}: ${diff ? "decode both sides" : "decode"}` : "",
    "⇧⏎: split",
    diff ? "j/k: changes" : "",
    diff && !describe && info ? "[/]: versions" : "",
    field && fieldKey ? `${prettyKey(fieldKey)}: field at cursor over time` : "",
    ...(describe ? ["d: diff", "r: re-run"] : ["d: diff", "⇧D: describe"]),
    "y: yaml",
    "e: edit",
    "w: wrap",
    o.split ? "esc: close" : "esc: back",
  ]
    .filter(Boolean)
    .join(" · ");
  const decodeAction: ContextAction = { id: "kubewing.decode", label: diff ? "decode value (both versions)" : "decode value", key: decodeKey && prettyKey(decodeKey), run: () => dispatch("detail.decode") };
  const actions: ContextAction[] = field
    ? [{ id: "kubewing.fieldHistory", label: "history of this field", key: fieldKey && prettyKey(fieldKey), run: () => dispatch("travel.field") }, decodeAction]
    : [decodeAction];
  const focus = () => setUI((s) => S.focusPane(s, pane.id));
  const viewer = { slot: pane.id, autoFocus: focused, onFocus: focus };
  return (
    <div role="region" aria-label="object detail" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 whitespace-nowrap border-b border-border px-2 py-0.5 text-fg-muted" aria-busy={stale || undefined}>
        <span className="shrink-0">
          {describe
            ? diff
              ? `describe diff (look ${described && "prevAt" in described && described.prevAt ? `${ago(described.prevAt)} ago` : "–"} → now, times ignored)`
              : "describe"
            : diff
              ? "diff (normalized)"
              : "yaml"}
        </span>
        {data && "deleted" in data && data.deleted ? <span className="shrink-0 text-deleted">deleted</span> : null}
        {diff && !describe && info ? <VersionNav paneId={pane.id} info={info} /> : null}
        {diff && !describe && data && "yaml" in data && !info ? (
          <span className="shrink-0" title="record history (status line, or ⇧R in the table) keeps this source's versions, within its memory budget, to step through with [ / ]">
            previous → current
          </span>
        ) : null}
        {diff ? <DiffNav paneId={pane.id} /> : null}
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
            <Viewer key="describe-diff" label="describe diff" language="plaintext" original={described.prevNorm} value={described.curNorm!} {...viewer} />
          ) : (
            <Viewer key="describe" label="describe" language="plaintext" value={described.text} {...viewer} />
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
          // one diff editor across versions and followed rows: the models are swapped, the scroll position stays
          <Viewer key="diff" label="diff" original={data.prevNorm} value={data.curNorm} contextActions={actions} {...viewer} />
        ) : (
          <Viewer key="yaml" label="yaml" value={data.yaml} contextActions={actions} {...viewer} />
        )}
      </div>
    </div>
  );
}

/** A newer response that shows the same thing keeps the old object (no Monaco reload while following). */
function same(a: DetailData, b: DetailData) {
  return a.yaml === b.yaml && a.curNorm === b.curNorm && a.prevNorm === b.prevNorm && a.deleted === b.deleted && a.diff?.to === b.diff?.to && a.diff?.first === b.diff?.first && a.diff?.last === b.diff?.last;
}

/** Older/newer version ([ / ]): which two versions are diffed, when they were seen, how many are kept. */
function VersionNav({ paneId, info }: { paneId: string; info: DiffInfo }) {
  const btn = "rounded border border-border px-1.5 leading-tight text-fg enabled:hover:border-accent disabled:opacity-40";
  const go = (cmd: "diff.older" | "diff.newer") => (e: React.MouseEvent) => {
    e.preventDefault(); // the viewer keeps the focus
    setUI((s) => S.focusPane(s, paneId));
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
    <ul aria-label="changed fields" className="border-b border-border px-2 py-0.5 font-mono text-fg-muted">
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
function DiffNav({ paneId, slot = paneId }: { paneId: string; slot?: string }) {
  const { index, total } = useDiffNavOf(slot);
  const btn = "rounded border border-border px-1.5 leading-tight text-fg enabled:hover:border-accent disabled:opacity-40";
  // mousedown + preventDefault: the viewer keeps the focus, so j/k go on working
  const go = (cmd: "diff.prev" | "diff.next") => (e: React.MouseEvent) => {
    e.preventDefault();
    setUI((s) => S.focusPane(s, paneId));
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

function size(n: number) {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / (1 << 20)).toFixed(1)} MiB`;
}

/**
 * ⏎ in the object view: the field under its cursor decoded, in its place.
 * The breadcrumb has the field through the levels gone down; the chain (a
 * click on a step leaves it and those after out) is above the value. ⏎ in
 * decoded YAML goes a level deeper, Esc back up. In the object diff it's the
 * decoded diff: the field in both versions with the same chain, [ / ]
 * stepping versions. Go decodes from the object on every request: nothing
 * decoded is kept.
 */
function DecodeView({ pane, o, d, focused }: { pane: S.PaneState; o: S.ObjectView; d: S.DecodeState; focused: boolean }) {
  const serverId = pane.serverId;
  const [data, setData] = useState<Decoded | { error: string }>();
  // per level (its path through the levels), the viewer's cursor and scroll: back from a deeper one, it's where it was
  const views = useRef(new Map<string, ViewState>());
  const bound = useKey("detail.decode");
  const key = bound ? prettyKey(bound) : "";

  useEffect(() => {
    if (!serverId) return;
    let live = true;
    const paneId = pane.id;
    const refused = (why: string) => {
      // a new level that has nothing to decode on its line: back where it came from, the reason in the status line
      if (d.levels[d.levels.length - 1]!.path === undefined) {
        setUI((s) => S.decodeUp(s, paneId));
        return flash(paneId, why, true);
      }
      setData({ error: why });
    };
    bridge()
      .decode(serverId, { key: o.key, which: d.which, to: d.version ?? 0, diff: d.diff, levels: d.levels })
      .then(
        (r) => {
          if (!live) return;
          if (r.refused) return refused(r.refused);
          shownDecode.set(paneId, r);
          // Go names the field through all the levels (a → doc 2: b): each crumb is its own level's
          setDecodePath(paneId, r.levels.length - 1, r.path.split(" → ").at(-1) ?? r.path, r.path);
          setData(r);
          // the levels as Go resolved them (paths, chains): other versions and toggles go by those
          setUI((x) => S.decodeResolved(x, paneId, r.levels));
        },
        (e: Error) => live && setData({ error: e.message }),
      );
    return () => {
      live = false;
    };
  }, [serverId, o.key, d.gen]);

  // the decoded diff's versions, for [ / ] (the object's stay its own, under it)
  const slot = viewSlot(pane.id, true);
  const info = data && "text" in data ? data.diff : undefined;
  useEffect(() => {
    if (!info) return;
    setDiffRange(slot, { to: info.to, first: info.first, last: info.last });
    return () => setDiffRange(slot, undefined);
  }, [slot, info?.to, info?.first, info?.last]);

  useEffect(
    () => () => {
      shownDecode.delete(pane.id);
      views.current.clear();
    },
    [],
  );

  const viewOf = (k: string) => {
    let v = views.current.get(k);
    if (!v) views.current.set(k, (v = {}));
    return v;
  };
  const loaded = data && "text" in data ? data : undefined;
  const actions: ContextAction[] | undefined =
    !d.diff && loaded?.language === "yaml" ? [{ id: "kubewing.decodeDeeper", label: "decode value", key, run: () => dispatch("detail.decode") }] : undefined;
  const hints = [
    d.diff ? "j/k: changes" : "",
    d.diff && info ? "[/]: versions" : "",
    !d.diff && key && loaded?.language === "yaml" ? `${key}: decode deeper` : "",
    "⇧⏎: split",
    "w: wrap",
    d.levels.length > 1 ? "esc: up" : "esc: back",
  ]
    .filter(Boolean)
    .join(" · ");
  const focus = () => setUI((s) => S.focusPane(s, pane.id));
  const viewer = { slot, autoFocus: focused, onFocus: focus };

  return (
    <div role="region" aria-label="decoded value" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 whitespace-nowrap border-b border-border px-2 py-0.5 text-fg-muted">
        {loaded ? <Chain paneId={pane.id} data={loaded} toggled={!!d.toggled} /> : <span>decoding…</span>}
        {d.diff && info ? <VersionNav paneId={pane.id} info={info} /> : null}
        {d.diff && loaded ? <DiffNav slot={slot} paneId={pane.id} /> : null}
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
          <Viewer key="decode-diff" label="decoded diff" language={lang(data)} original={data.prev!.text} value={data.text} {...viewer} />
        ) : (
          <Viewer key={levelKey(data)} label="decoded" language={lang(data)} value={data.text} contextActions={actions} viewState={viewOf(levelKey(data))} {...viewer} />
        )}
      </div>
    </div>
  );
}

const lang = (d: Decoded) => (d.language === "yaml" ? "yaml" : "plaintext");

/** A loaded level, by its path through the levels and how it's decoded: its viewer, and the cursor kept for it. */
const levelKey = (d: Decoded) => `decode ${d.levels.map((l) => `${JSON.stringify(l.path)}|${l.doc ?? 0}|${(l.steps ?? []).join(",")}|${l.raw ? 1 : 0}`).join(" > ")}`;

/** The chain: base64 → brotli → yaml · 14.2 KiB; a click on a step leaves it (and what follows) out, on the rendering shows the raw text. */
function Chain({ paneId, data, toggled }: { paneId: string; data: Decoded; toggled: boolean }) {
  const steps = data.steps ?? [];
  const last = data.levels[data.levels.length - 1];
  const reset = (e: React.MouseEvent) => {
    e.preventDefault();
    setUI((s) => S.decodeAuto(S.focusPane(s, paneId), paneId));
  };
  const toggle = (step: number | "render") => (e: React.MouseEvent) => {
    e.preventDefault(); // the viewer keeps the focus
    setUI((x) => S.decodeToggle(S.focusPane(x, paneId), paneId, data.levels, step));
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

/**
 * e (as kubectl edit), in the object view: the object's YAML in the editor;
 * ⌘S dry-runs it on the server and shows what would change, ⏎ there writes
 * it. The pane's frame has the context's color, as always.
 */
function EditView({ pane, e, focused }: { pane: S.PaneState; e: S.EditState; focused: boolean }) {
  const preview = e.preview;
  const focus = () => setUI((s) => S.focusPane(s, pane.id));
  return (
    <div role="region" aria-label="edit object" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 whitespace-nowrap border-b border-border px-2 py-0.5 text-fg-muted">
        <span className="text-fg">{e.title}</span>
        <span>{preview ? "preview (server dry run: current → after the edit)" : e.yaml !== e.opened ? "edit (changed)" : "edit"}</span>
        {preview ? <DiffNav paneId={pane.id} slot={`${pane.id}/edit`} /> : null}
        <span className="ml-auto min-w-0 truncate">{preview ? "⏎ / ⌘⏎: apply · j/k: changes · w: wrap · esc: back to editing" : "⌘S / ⌘⏎: preview · esc: close"}</span>
      </div>
      <div className="min-h-0 flex-1">
        {preview ? (
          <Viewer key="edit-preview" label="edit preview" original={preview.prevNorm} value={preview.curNorm} slot={`${pane.id}/edit`} autoFocus={focused} onFocus={focus} />
        ) : (
          // the key remounts the editor with the current text when it comes back from the preview
          <Editor
            key={`edit-${e.session}`}
            label="edit YAML"
            initial={e.yaml}
            autoFocus={focused}
            onFocus={focus}
            onChange={(yaml) => setUI((x) => S.setEdit(x, pane.id, (d) => ({ ...d, yaml, discarding: false })))}
          />
        )}
      </div>
      {e.discarding ? (
        <div role="status" className="border-t border-border px-2 py-1 text-changed">
          unsaved changes: esc again discards them
        </div>
      ) : e.error ? (
        <div role="alert" className="border-t border-border px-2 py-1 whitespace-pre-wrap text-deleted select-text">
          {e.error}
        </div>
      ) : null}
    </div>
  );
}
