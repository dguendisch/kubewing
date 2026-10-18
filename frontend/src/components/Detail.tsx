import { useEffect, useState } from "react";
import { Viewer } from "../editor/Viewer";
import { bridge, useUI } from "../store/store";
import type { DescribeResult, Detail as DetailData } from "../transport/types";

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

/**
 * Detail overlay, in Monaco: full YAML, (d) diff of the previous vs. current
 * normalized object, or (⇧D) kubectl describe output.
 */
export function Detail() {
  const overlay = useUI((s) => s.overlay);
  const serverId = useUI((s) => (s.overlay ? s.panes[s.overlay.pane]?.serverId : undefined));
  const [data, setData] = useState<DetailData | { error: string }>();
  const [described, setDescribed] = useState<DescribeResult | { error: string }>();
  const describe = overlay?.kind === "detail" && overlay.view === "describe";
  const gen = overlay?.describeGen ?? 0;

  useEffect(() => {
    setData(undefined);
    if (!overlay || overlay.kind !== "detail" || !serverId || !overlay.key) return;
    bridge().object(serverId, overlay.key).then(setData, (e: Error) => setData({ error: e.message }));
  }, [overlay?.key, serverId, overlay?.kind]);

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

  if (!overlay || overlay.kind !== "detail") return null;
  const diff = !!overlay.diff;
  return (
    <div role="dialog" aria-label="object detail" className="absolute inset-6 z-20 flex flex-col border border-accent bg-bg-elev shadow-2xl">
      <div className="flex gap-3 border-b border-border px-3 py-1 text-fg-muted">
        <span className="text-fg">{data && "name" in data ? data.name : "…"}</span>
        <span>
          {describe
            ? diff
              ? `describe diff (look ${described && "prevAt" in described && described.prevAt ? `${ago(described.prevAt)} ago` : "–"} → now, times ignored)`
              : "describe"
            : diff
              ? "diff (prev → current, normalized)"
              : "yaml"}
        </span>
        <span className="ml-auto">{describe ? "d: diff · r: re-run · " : "d: diff · ⇧D: describe · "}y: yaml · ⌘F find · esc: close</span>
      </div>
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
          <div className="p-3 text-fg-muted">no previous version seen since watch start</div>
        ) : diff ? (
          <Viewer key="diff" label="diff" original={data.prevNorm} value={data.curNorm} />
        ) : (
          <Viewer key="yaml" label="yaml" value={data.yaml} />
        )}
      </div>
    </div>
  );
}
