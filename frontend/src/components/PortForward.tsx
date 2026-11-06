import { useEffect, useRef, useState } from "react";
import { flash } from "../commands";
import { rank, type Candidate } from "../complete/complete";
import { chord } from "../keys/keymap";
import { bridge, setUI, usePortForwards, useUI } from "../store/store";
import * as S from "../store/state";
import type { PortForward } from "../transport/types";
import { describeForward, forwardedRemotes, forwardsTo, forwardTarget, lastToken, listedRemotes, parsePorts, portCandidates } from "./ports";

/**
 * f: port-forwards of the selected pod or service. Lists the ones already
 * running (✕ stops one) and starts new ones on 127.0.0.1: a single declared
 * port not forwarded yet is prefilled; with several, they're offered in a
 * list (number, name, protocol, container or target port) to pick one or
 * more from. A service's ports are service ports: Go picks one of its pods
 * and forwards to their target ports, as kubectl port-forward svc/… does.
 */
export function PortForwardDialog() {
  const overlay = useUI((s) => s.overlay);
  const serverId = useUI((s) => (s.overlay ? s.panes[s.overlay.pane]?.serverId : undefined));
  const context = useUI((s) => (s.overlay ? s.panes[s.overlay.pane]?.context : undefined));
  if (overlay?.kind !== "portforward" || !serverId || !overlay.key) return null;
  return <Dialog key={overlay.key} paneId={overlay.pane} serverId={serverId} context={context} rowKey={overlay.key} />;
}

function Dialog({ paneId, serverId, context, rowKey }: { paneId: string; serverId: string; context?: string; rowKey: string }) {
  const [row, setRow] = useState<{ name: string; namespace?: string; service: boolean }>();
  const [ports, setPorts] = useState("");
  const [error, setError] = useState<string>();
  const [declared, setDeclared] = useState<Candidate[]>([]);
  const [open, setOpen] = useState(false);
  // highlighted entry of the port list; -1 = none, so ⏎ forwards what's in the field
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const runningList = useRef<HTMLUListElement>(null);
  const [inList, setInList] = useState(false);
  const [pick, setPick] = useState(0);
  const all = usePortForwards((s) => s.list);
  const running = row ? forwardsTo(all, context, row.namespace, row.name, row.service) : [];
  const busy = forwardedRemotes(running);

  // offered: declared ports not forwarded yet; one left is prefilled, several are a list to pick from
  useEffect(() => {
    bridge()
      .rowInfo(serverId, rowKey)
      .then((r) => {
        setRow({ name: r.name, namespace: r.namespace, service: !!r.service });
        const c = portCandidates(r.portInfo ?? []);
        setDeclared(c);
        const taken = forwardedRemotes(forwardsTo(usePortForwards.getState().list, context, r.namespace, r.name, !!r.service));
        const free = c.filter((x) => !taken.has(Number(x.label)));
        const usable = free.filter((x) => !x.disabled);
        // a single forwardable port alone: prefilled; otherwise the list (it also says why UDP ports can't go)
        if (usable.length === 1 && free.length === 1) setPorts((p) => p || usable[0]!.value);
        else if (free.length > 0) setOpen(true);
      }, () => {});
  }, [serverId, rowKey]);

  const listed = listedRemotes(ports);
  const offered = declared.filter((c) => !busy.has(Number(c.label)));
  const { from, word } = lastToken(ports);
  const matches = open ? rank(word, offered.filter((c) => !listed.has(Number(c.label)))) : [];
  // the highlight only lands on ports that can be forwarded
  const pickable = matches.filter((m) => !m.candidate.disabled);
  const cur = active < 0 ? undefined : pickable[Math.min(active, pickable.length - 1)];
  // a pick replaces the token being typed and leaves room for the next one; the list
  // stays open with nothing highlighted: ⏎ now forwards, ↓ highlights another port to add
  const accept = (c: Candidate) => {
    if (c.disabled) return;
    setPorts(`${ports.slice(0, from)}${c.value} `);
    setActive(-1);
    setError(undefined);
    input.current?.focus();
  };

  // the list closes on an error so it doesn't cover the message; typing (or ↓) opens it again
  const fail = (msg: string) => {
    setOpen(false);
    setError(msg);
  };
  // one forward per port, so each is listed and stopped on its own. Those that
  // fail stay in the field with the error; those that started keep running.
  const submit = async () => {
    const list = parsePorts(ports);
    if (typeof list === "string") return fail(list);
    const started: string[] = [];
    const failed: { spec: string; err: string }[] = [];
    for (const spec of list) {
      try {
        started.push(describeForward(await bridge().portForwardStart(serverId, rowKey, [spec])));
      } catch (e) {
        failed.push({ spec, err: String((e as Error).message ?? e) });
      }
    }
    if (!failed.length) {
      setUI(S.closeOverlay);
      return flash(paneId, `forwarding ${started.join(", ")} (f again to stop)`);
    }
    setPorts(`${failed.map((f) => f.spec).join(" ")} `);
    fail(failed.map((f) => `${f.spec}: ${f.err}`).join("\n"));
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
      <div className="text-fg">port-forward {row ? `${row.service ? "svc/" : ""}${row.name}` : "…"}</div>
      {running.length ? (
        <ul
          ref={runningList}
          role="listbox"
          tabIndex={-1}
          aria-label="running port-forwards"
          aria-activedescendant={inList ? `fw-${running[pick]?.id}` : undefined}
          onFocus={() => setInList(true)}
          onBlur={() => setInList(false)}
          onKeyDown={(e) => {
            const n = running.length;
            const back = () => {
              e.preventDefault();
              e.stopPropagation(); // Esc returns to the field instead of closing the dialog
              input.current?.focus();
            };
            // the same keys as the global list (⌥⌘P): ↑/↓ pick, x or ⌫ stops (the field
            // doesn't have the focus here, so x is no text being typed)
            const c = chord(e);
            if (c === "ArrowDown") (e.preventDefault(), setPick((p) => Math.min(p + 1, n - 1)));
            else if (c === "ArrowUp") (e.preventDefault(), setPick((p) => Math.max(p - 1, 0)));
            else if (c === "X" || c === "Backspace") {
              e.preventDefault();
              const f = running[pick];
              if (f) void bridge().portForwardStop(f.id).catch(() => {});
              // the last one gone: the list goes away, back to the field
              if (n === 1) input.current?.focus();
              else setPick((p) => Math.min(p, n - 2));
            } else if (c === "Escape" || c === "Tab") back();
            else if (c === "Enter") e.preventDefault(); // no submit from here
          }}
          className="flex flex-col gap-0.5 outline-none"
        >
          {running.map((f, i) => (
            <ForwardRow key={f.id} f={f} active={inList && i === pick} />
          ))}
        </ul>
      ) : null}
      <label className="relative flex flex-col gap-1 text-fg-muted">
        {row?.service ? "service ports (local:port, or port for a random local port)" : "ports (local:remote, or remote for a random local port)"}
        <input
          ref={input}
          autoFocus
          role="combobox"
          aria-label="ports"
          aria-expanded={matches.length > 0}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          value={ports}
          onChange={(e) => {
            setPorts(e.target.value);
            setError(undefined);
            setOpen(offered.length > 1);
            setActive(0);
          }}
          onKeyDown={(e) => {
            // ⇧⇥: up to the running forwards (↑/↓ pick, x or ⌫ stops, ⇥/esc come back)
            if (e.key === "Tab" && e.shiftKey && running.length) {
              e.preventDefault();
              setOpen(false);
              runningList.current?.focus();
              return;
            }
            if (!matches.length) {
              if (e.key === "ArrowDown" && offered.length) (e.preventDefault(), setOpen(true));
              return;
            }
            // the highlight moves over the forwardable ports only
            const n = pickable.length;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              // from nothing highlighted, ↓ starts at the first and ↑ at the last
              if (n) setActive((a) => (a < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (Math.min(a, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n));
            } else if (e.key === "Enter" && cur) {
              // ⏎ adds the highlighted port; with none highlighted it falls through and forwards
              e.preventDefault();
              accept(cur.candidate);
            } else if (e.key === "Tab" && pickable[0]) {
              // ⇥ completes to the highlighted (else the best) match, as in ⌘O
              e.preventDefault();
              accept((cur ?? pickable[0]).candidate);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation(); // the list closes first, the dialog on the next esc
              setOpen(false);
            }
          }}
          onBlur={() => setOpen(false)}
          className="rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent"
        />
        {matches.length ? (
          <ul role="listbox" aria-label="declared ports" className="absolute top-full right-0 left-0 z-40 mt-px max-h-64 overflow-y-auto border border-border bg-bg-elev">
            {matches.map((m) => (
              <li
                key={m.candidate.value}
                role="option"
                aria-selected={m === cur}
                aria-disabled={m.candidate.disabled ? true : undefined}
                title={m.candidate.disabled}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(m.candidate);
                }}
                className={`flex justify-between gap-3 px-2 py-0.5 ${m === cur ? "bg-bg-hover text-fg" : "text-fg-muted"} ${m.candidate.disabled ? "opacity-50" : ""}`}
              >
                <span className="text-fg">{m.candidate.label}</span>
                <span className="shrink-0">{m.candidate.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </label>
      {/* one line per port that failed */}
      {error ? (
        <div role="alert" className="whitespace-pre-line text-deleted">
          {error}
        </div>
      ) : null}
      <div className="text-fg-muted">
        {inList
          ? "↑/↓ pick · x or ⌫ stop · ⇥/esc back to the ports"
          : `${cur ? "⏎ add the highlighted port" : `${matches.length ? "↓ pick a port · " : ""}⏎ forward on 127.0.0.1`}${running.length ? " · ⇧⇥ running forwards" : ""} · esc cancel`}
      </div>
    </form>
  );
}

/** One running forward with a stop button; an ended one shows why. */
function ForwardRow({ f, where, active }: { f: PortForward; where?: boolean; active?: boolean }) {
  // a service's forward names the pod it picked, also in the service's dialog
  const target = forwardTarget(f);
  const stop = (e: React.MouseEvent) => {
    e.preventDefault(); // keep the focus where it is (the ports field, the list)
    void bridge().portForwardStop(f.id).catch(() => {});
  };
  return (
    <li id={`fw-${f.id}`} role={where ? undefined : "option"} aria-selected={where ? undefined : !!active} className={`flex items-center gap-3 ${active ? "bg-bg-hover" : ""}`}>
      {/* the ports never wrap; the pod name truncates instead */}
      <span className={`shrink-0 whitespace-nowrap ${f.error ? "text-fg-muted line-through" : "text-fg"}`}>{describeForward(f)}</span>
      {where ? (
        <span className="min-w-0 truncate text-fg-muted" title={`${f.context} · ${target}`}>
          {f.context} · {target}
        </span>
      ) : f.service ? (
        <span className="min-w-0 truncate text-fg-muted" title={`to pod ${f.pod}`}>
          pod {f.pod}
        </span>
      ) : null}
      {f.error ? <span className="truncate text-deleted">{f.error}</span> : null}
      {/* in the pod/service dialog the list is the keyboard stop (⌫); the button is for the mouse */}
      <button type="button" tabIndex={where ? undefined : -1} aria-label={`stop ${describeForward(f)}`} title={f.error ? "remove" : "stop"} onMouseDown={stop} className="ml-auto rounded border border-border px-1.5 leading-tight text-fg-muted hover:border-deleted hover:text-deleted">
        ✕
      </button>
    </li>
  );
}

/** ⌥⌘P or the ⇄ badge: every port-forward; ↑/↓ select, x or ⌫ (or ✕) stops, esc closes. */
export function PortForwardList() {
  const overlay = useUI((s) => s.overlay);
  const list = usePortForwards((s) => s.list);
  if (overlay?.kind !== "forwards") return null;
  const sel = Math.min(overlay.index ?? 0, Math.max(0, list.length - 1));
  return (
    <div role="dialog" aria-label="port-forwards" className="absolute top-16 left-1/2 z-30 flex w-[36rem] -translate-x-1/2 flex-col border border-accent bg-bg-elev shadow-2xl">
      <div className="border-b border-border px-3 py-1 text-fg">port-forwards</div>
      {list.length === 0 ? (
        <div className="px-3 py-2 text-fg-muted">none · f on a pod or service starts one</div>
      ) : (
        <ul role="listbox" aria-label="active port-forwards">
          {list.map((f, i) => (
            <li key={f.id} role="option" aria-selected={i === sel} className={`px-3 py-0.5 ${i === sel ? "bg-bg-hover" : ""}`}>
              <ul>
                <ForwardRow f={f} where />
              </ul>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border px-3 py-1 text-fg-muted">↑/↓ select · x or ⌫ stop · esc close</div>
    </div>
  );
}
