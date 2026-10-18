import { useEffect, useState } from "react";
import { Viewer } from "../editor/Viewer";
import { bridge, useUI } from "../store/store";
import type { Detail as DetailData } from "../transport/types";

/**
 * Detail overlay, in Monaco: full YAML, (d) diff of the previous vs. current
 * normalized object, or (⇧D) kubectl describe output.
 */
export function Detail() {
  const overlay = useUI((s) => s.overlay);
  const serverId = useUI((s) => (s.overlay ? s.panes[s.overlay.pane]?.serverId : undefined));
  const [data, setData] = useState<DetailData | { error: string }>();
  const [described, setDescribed] = useState<{ text: string } | { error: string }>();
  const describe = overlay?.kind === "detail" && overlay.view === "describe";

  useEffect(() => {
    setData(undefined);
    if (!overlay || overlay.kind !== "detail" || !serverId || !overlay.key) return;
    bridge().object(serverId, overlay.key).then(setData, (e: Error) => setData({ error: e.message }));
  }, [overlay?.key, serverId, overlay?.kind]);

  useEffect(() => {
    setDescribed(undefined);
    if (!describe || !serverId || !overlay?.key) return;
    bridge().describe(serverId, overlay.key).then((text) => setDescribed({ text }), (e: Error) => setDescribed({ error: e.message }));
  }, [describe, overlay?.key, serverId]);

  if (!overlay || overlay.kind !== "detail") return null;
  const diff = !!overlay.diff;
  return (
    <div role="dialog" aria-label="object detail" className="absolute inset-6 z-20 flex flex-col border border-accent bg-bg-elev shadow-2xl">
      <div className="flex gap-3 border-b border-border px-3 py-1 text-fg-muted">
        <span className="text-fg">{data && "name" in data ? data.name : "…"}</span>
        <span>{describe ? "describe" : diff ? "diff (prev → current, normalized)" : "yaml"}</span>
        <span className="ml-auto">d: diff · ⇧D: describe · y: yaml · ⌘F find · esc: close</span>
      </div>
      <div className="min-h-0 flex-1">
        {describe ? (
          !described ? (
            <div className="p-3">loading…</div>
          ) : "error" in described ? (
            <div className="p-3 text-deleted">{described.error}</div>
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
