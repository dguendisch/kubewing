import { useEffect, useState } from "react";
import { bridge, useUI } from "../store/store";
import type { Detail as DetailData } from "../transport/types";
import { lineDiff } from "./diff";

/** Detail overlay: full YAML, or (d) text diff of previous vs. current normalized object. */
export function Detail() {
  const overlay = useUI((s) => s.overlay);
  const serverId = useUI((s) => (s.overlay ? s.panes[s.overlay.pane]?.serverId : undefined));
  const [data, setData] = useState<DetailData | { error: string }>();

  useEffect(() => {
    setData(undefined);
    if (!overlay || overlay.kind !== "detail" || !serverId || !overlay.key) return;
    bridge().object(serverId, overlay.key).then(setData, (e: Error) => setData({ error: e.message }));
  }, [overlay?.key, serverId, overlay?.kind]);

  if (!overlay || overlay.kind !== "detail") return null;
  return (
    <div role="dialog" aria-label="object detail" className="absolute inset-6 z-20 flex flex-col border border-accent bg-bg-elev shadow-2xl">
      <div className="flex gap-3 border-b border-border px-3 py-1 text-fg-muted">
        <span className="text-fg">{data && "name" in data ? data.name : "…"}</span>
        <span>{overlay.diff ? "diff (prev → current, normalized)" : "yaml"}</span>
        <span className="ml-auto">d: toggle diff · esc: close</span>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-3 select-text">
        {!data ? "loading…" : "error" in data ? data.error : overlay.diff ? <DiffView d={data} /> : data.yaml}
      </pre>
    </div>
  );
}

function DiffView({ d }: { d: DetailData }) {
  if (!d.prevNorm) return <span className="text-fg-muted">no previous version seen since watch start</span>;
  return (
    <>
      {lineDiff(d.prevNorm, d.curNorm).map((l, i) => (
        <div key={i} className={l.op === "+" ? "bg-added/15 text-added" : l.op === "-" ? "bg-deleted/15 text-deleted" : "text-fg-muted"}>
          {l.op} {l.text}
        </div>
      ))}
    </>
  );
}
