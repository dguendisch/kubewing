import { useEffect, useRef, useState } from "react";
import { submitMeta } from "../commands";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import { hasChanges, parseMeta, parseReplicas, type MetaChange } from "./metaForm";

/**
 * ⇧L / ⇧A / s: label, annotate or scale the selected row, as kubectl
 * label / annotate / scale do. Label and annotate list the current keys (a
 * click takes one into the field, to change its value) and take
 * `key=value` (set) and `key-` (remove), previewed as they're typed; scale
 * takes the replicas, prefilled with the current ones. The action is
 * already prepared (the safety policy said yes); a confirmation, if the
 * rule asks for one, comes after. ⏎ applies, Esc cancels. A refusal (an
 * invalid key, a webhook) stays in the dialog with the text kept.
 */
export function MetaDialog() {
  const o = useUI((s) => (s.overlay?.kind === "meta" ? s.overlay : undefined));
  const serverId = useUI((s) => (s.overlay?.kind === "meta" ? s.panes[s.overlay.pane]?.serverId : undefined));
  if (!o?.pending || !o.key || !serverId) return null;
  const kind = o.pending.action.kind;
  if (kind === "scale") return <Scale key={o.key} serverId={serverId} rowKey={o.key} name={o.pending.action.name} />;
  if (kind !== "label" && kind !== "annotate") return null;
  return <Meta key={`${kind}/${o.key}`} kind={kind} serverId={serverId} rowKey={o.key} name={o.pending.action.name} />;
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e);
const field = "rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent";
const frame = "absolute top-16 left-1/2 z-30 flex -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-2xl";

function Meta({ kind, serverId, rowKey, name }: { kind: "label" | "annotate"; serverId: string; rowKey: string; name: string }) {
  const [current, setCurrent] = useState<Record<string, string>>();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const what = kind === "label" ? "labels" : "annotations";

  useEffect(() => {
    bridge()
      .rowMeta(serverId, rowKey)
      .then(
        (m) => setCurrent((kind === "label" ? m.labels : m.annotations) ?? {}),
        (e) => setError(errorText(e)),
      );
  }, [serverId, rowKey]);

  const parsed = parseMeta(text, current ?? {});
  const changes = "changes" in parsed ? parsed.changes : [];
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const added = changes.filter((c) => c.op === "add");

  const submit = () => {
    if ("error" in parsed) return setError(parsed.error);
    if (!hasChanges(parsed.send)) return setError(changes.length ? "no changes: every key already has that value" : "key=value sets, key- removes");
    setBusy(true);
    void submitMeta({ meta: { changes: parsed.send, text: text.trim().replace(/\s+/g, " ") } }).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };
  // a click on a key takes it into the field (to change its value, or remove it with key-)
  const take = (k: string, v: string) => {
    const token = `${k}=${quote(v)}`;
    setText((t) => (t.trim() ? `${t.trimEnd()} ${token}` : token));
    setError(undefined);
    input.current?.focus();
  };

  return (
    <form
      role="dialog"
      aria-label={kind}
      className={`${frame} w-[36rem]`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <div className="text-fg">
        {kind} <span className="font-semibold">{name}</span>
      </div>
      <ul aria-label={what} className="flex max-h-60 flex-col overflow-auto border border-border py-0.5">
        {current === undefined ? <li className="px-2 text-fg-muted">loading…</li> : null}
        {current && !Object.keys(current).length && !added.length ? <li className="px-2 text-fg-muted">no {what}</li> : null}
        {Object.entries(current ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => (
            <Entry key={k} k={k} v={v} change={byKey.get(k)} onClick={() => take(k, v)} />
          ))}
        {added.map((c) => (
          <Entry key={c.key} k={c.key} v={c.value!} change={c} />
        ))}
      </ul>
      <label className="flex flex-col gap-1 text-fg-muted">
        key=value sets · key- removes{kind === "annotate" ? ' · "quotes" keep spaces' : ""}
        <input
          ref={input}
          autoFocus
          aria-label="changes"
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
          placeholder={kind === "label" ? "e.g. env=prod tier-" : 'e.g. note="drained for maintenance"'}
          className={`w-full ${field} ${error ? "border-deleted" : ""}`}
        />
      </label>
      {error ? (
        <div role="alert" className="text-deleted select-text">
          {error}
        </div>
      ) : null}
      <div className="text-fg-muted">{busy ? "applying…" : `⏎ ${kind} · esc cancel`}</div>
    </form>
  );
}

/** A value as the field takes it back: quoted if it has spaces or quotes (in the kind of quote it doesn't contain). */
function quote(v: string): string {
  if (!/[\s"']/.test(v)) return v;
  return v.includes('"') ? `'${v}'` : `"${v}"`;
}

/** One key: as it is, or as the typed text changes it. */
function Entry({ k, v, change, onClick }: { k: string; v: string; change?: MetaChange; onClick?: () => void }) {
  const op = change?.op;
  const color = op === "add" ? "text-added" : op === "change" ? "text-changed" : op === "remove" ? "text-deleted line-through" : "text-fg";
  return (
    <li data-op={op} className={`flex gap-1 px-2 ${onClick ? "cursor-pointer hover:bg-bg-hover" : ""}`} onClick={onClick} title={onClick ? "take it into the field" : undefined}>
      <span className="w-4 shrink-0 text-fg-muted">{op === "add" ? "+" : op === "change" ? "~" : op === "remove" ? "−" : ""}</span>
      <span className={`shrink-0 ${color}`}>{k}</span>
      <span className="text-fg-muted">=</span>
      {op === "change" ? (
        <span className="truncate">
          <span className="text-fg-muted line-through">{v}</span> <span className="text-changed">{change!.value}</span>
        </span>
      ) : (
        <span className={`truncate ${op === "remove" ? "text-fg-muted line-through" : op === "add" ? "text-added" : "text-fg-muted"}`}>{v}</span>
      )}
    </li>
  );
}

function Scale({ serverId, rowKey, name }: { serverId: string; rowKey: string; name: string }) {
  const [from, setFrom] = useState<number>();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bridge()
      .rowInfo(serverId, rowKey)
      .then(
        (r) => {
          setFrom(r.replicas);
          // prefilled and selected: typing replaces it
          setText((t) => t || String(r.replicas ?? ""));
          requestAnimationFrame(() => input.current?.select());
        },
        (e) => setError(errorText(e)),
      );
  }, [serverId, rowKey]);

  const submit = () => {
    const r = parseReplicas(text);
    if ("error" in r) return setError(r.error);
    if (r.replicas === from) return setError(`already at ${from}`);
    setBusy(true);
    void submitMeta({ scale: { replicas: r.replicas, from } }).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };

  return (
    <form
      role="dialog"
      aria-label="scale"
      className={`${frame} w-[24rem]`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <div className="text-fg">
        scale <span className="font-semibold">{name}</span>
        {from !== undefined ? <span className="text-fg-muted"> · now {from}</span> : null}
      </div>
      <label className="flex items-baseline gap-2 text-fg-muted">
        replicas
        <input
          ref={input}
          autoFocus
          aria-label="replicas"
          inputMode="numeric"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
          className={`w-24 ${field} ${error ? "border-deleted" : ""}`}
        />
      </label>
      {error ? (
        <div role="alert" className="text-deleted select-text">
          {error}
        </div>
      ) : null}
      <div className="text-fg-muted">{busy ? "scaling…" : "⏎ scale · esc cancel"}</div>
    </form>
  );
}
