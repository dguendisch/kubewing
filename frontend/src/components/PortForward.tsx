import { useEffect, useState } from "react";
import { flash } from "../commands";
import { bridge, setUI, usePortForwards, useUI } from "../store/store";
import * as S from "../store/state";
import { containerPorts, parsePorts } from "./ports";

/** ⇧F: forward ports of the selected pod to 127.0.0.1 (pre-filled from its container ports). */
export function PortForwardDialog() {
  const overlay = useUI((s) => s.overlay);
  const serverId = useUI((s) => (s.overlay ? s.panes[s.overlay.pane]?.serverId : undefined));
  if (overlay?.kind !== "portforward" || !serverId || !overlay.key) return null;
  return <Dialog key={overlay.key} paneId={overlay.pane} serverId={serverId} rowKey={overlay.key} />;
}

function Dialog({ paneId, serverId, rowKey }: { paneId: string; serverId: string; rowKey: string }) {
  const [name, setName] = useState("…");
  const [ports, setPorts] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    bridge()
      .object(serverId, rowKey)
      .then((d) => {
        setName(d.name);
        setPorts((p) => p || containerPorts(d.yaml).map((x) => `${x}:${x}`).join(" "));
      }, () => {});
  }, [serverId, rowKey]);

  const submit = async () => {
    const list = parsePorts(ports);
    if (typeof list === "string") return setError(list);
    try {
      const f = await bridge().portForwardStart(serverId, rowKey, list);
      setUI(S.closeOverlay);
      flash(paneId, `forwarding ${f.ports.map((p) => `127.0.0.1:${p.local} → ${p.remote}`).join(", ")} (⌘⌥P lists)`);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <form
      role="dialog"
      aria-label="port-forward"
      className="absolute top-16 left-1/2 z-30 flex w-[28rem] -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <div className="text-fg">port-forward {name}</div>
      <label className="flex flex-col gap-1 text-fg-muted">
        ports (local:remote, or remote for a random local port)
        <input
          autoFocus
          aria-label="ports"
          value={ports}
          onChange={(e) => {
            setPorts(e.target.value);
            setError(undefined);
          }}
          className="rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent"
        />
      </label>
      {error ? (
        <div role="alert" className="text-deleted">
          {error}
        </div>
      ) : null}
      <div className="text-fg-muted">⏎ forward on 127.0.0.1 · esc cancel</div>
    </form>
  );
}

/** ⌘⌥P: active port-forwards; j/k select, ⌃D stops, esc closes. */
export function PortForwardList() {
  const overlay = useUI((s) => s.overlay);
  const list = usePortForwards((s) => s.list);
  if (overlay?.kind !== "forwards") return null;
  const sel = Math.min(overlay.index ?? 0, Math.max(0, list.length - 1));
  return (
    <div role="dialog" aria-label="port-forwards" className="absolute top-16 left-1/2 z-30 flex w-[36rem] -translate-x-1/2 flex-col border border-accent bg-bg-elev shadow-2xl">
      <div className="border-b border-border px-3 py-1 text-fg">port-forwards</div>
      {list.length === 0 ? (
        <div className="px-3 py-2 text-fg-muted">none · ⇧F on a pod starts one</div>
      ) : (
        <ul role="listbox" aria-label="active port-forwards">
          {list.map((f, i) => (
            <li
              key={f.id}
              role="option"
              aria-selected={i === sel}
              className={`flex gap-3 px-3 py-0.5 ${i === sel ? "bg-bg-hover" : ""}`}
            >
              <span className="text-fg">{f.ports.map((p) => `127.0.0.1:${p.local} → ${p.remote}`).join(", ")}</span>
              <span className="text-fg-muted">
                {f.context} · {f.namespace}/{f.pod}
              </span>
              {f.error ? <span className="ml-auto text-deleted">{f.error}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border px-3 py-1 text-fg-muted">j/k select · ⌃D stop · esc close</div>
    </div>
  );
}
