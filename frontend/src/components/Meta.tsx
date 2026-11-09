import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { submitMeta } from "../commands";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import type { Batch } from "../transport/types";
import { rank, type Candidate } from "../complete/complete";
import { hasChanges, parseMeta, parseReplicas, quoteValue, recentCandidates, tokenAt, unionCurrent, unionMeta, type MetaChange } from "./metaForm";

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
  if (o?.batch) {
    const b = o.batch;
    if (b.kind === "scale") return <ScaleMany key={b.pending[0]!.token} batch={b} />;
    if (b.kind === "label" || b.kind === "annotate") return <MetaMany key={b.pending[0]!.token} kind={b.kind} batch={b} />;
    return null;
  }
  if (!o?.pending || !o.key || !serverId) return null;
  const kind = o.pending.action.kind;
  if (kind === "scale") return <Scale key={o.key} serverId={serverId} rowKey={o.key} name={o.pending.action.name} />;
  if (kind !== "label" && kind !== "annotate") return null;
  return <Meta key={`${kind}/${o.key}`} kind={kind} serverId={serverId} rowKey={o.key} name={o.pending.action.name} />;
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e);
const field = "rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent";
const frame = "absolute top-16 left-1/2 z-30 flex -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-dialog";

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
    const token = `${k}=${quoteValue(v)}`;
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
        key=value sets · key- removes{kind === "annotate" ? ' · "quotes" keep spaces' : ""} · ↓ recent
        <ChangesField
          input={input}
          kind={kind}
          text={text}
          current={current}
          error={!!error}
          onChange={(t) => {
            setText(t);
            setError(undefined);
          }}
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

/**
 * The label / annotate dialog's text field. ↓ lists the pairs set lately
 * (history.yaml, per dialog: the last 20) for the word at the caret, ranked
 * as it's typed on; ⏎ or ⇥ takes one in place of that word (quoted as the
 * field takes it), a click too; ✕ forgets one; Esc closes the list (a second
 * Esc the dialog). Keys the rest of the text gives aren't offered.
 */
function ChangesField({ input, kind, text, current, error, onChange }: {
  input: React.RefObject<HTMLInputElement | null>;
  kind: "label" | "annotate";
  text: string;
  current?: Record<string, string>;
  error: boolean;
  onChange: (t: string) => void;
}) {
  const id = useId();
  const [recent, setRecent] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  // -1 = nothing active: ⏎ submits the dialog
  const [active, setActive] = useState(-1);
  useEffect(() => {
    bridge().metaHistory(kind).then((r) => setRecent(r ?? []), () => {});
  }, [kind]);

  const at = tokenAt(text, Math.min(caret, text.length));
  const matches = open ? rank(at.word, recentCandidates(recent, text, at, current), 20) : [];
  const shown = open && matches.length > 0;
  const cur = active >= 0 ? matches[active] : undefined;

  // the caret after a pick, once the new text is in the DOM
  const place = useRef<number>(undefined);
  useLayoutEffect(() => {
    if (place.current === undefined) return;
    input.current?.setSelectionRange(place.current, place.current);
    setCaret(place.current);
    place.current = undefined;
  });
  const accept = (c: Candidate) => {
    // the caret past the space after it, so the next can follow (↓ again); a token ends at a space or the end
    const after = text.slice(at.to) || " ";
    place.current = at.from + c.value.length + 1;
    onChange(text.slice(0, at.from) + c.value + after);
    setOpen(false);
    setActive(-1);
  };
  const preselect = (word: string, list = matches) => (word && list[0] && !list[0].fuzzy ? 0 : -1);

  return (
    <div className="relative">
      <input
        ref={input}
        autoFocus
        role="combobox"
        aria-label="changes"
        aria-expanded={shown}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={cur ? `${id}-${active}` : undefined}
        autoComplete="off"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          const t = e.target.value;
          const c = e.target.selectionStart ?? t.length;
          onChange(t);
          setCaret(c);
          if (!open) return;
          // a space ends the word: the list closes (↓ opens it for the next)
          const w = tokenAt(t, c);
          if (!w.word) return setOpen(false), setActive(-1);
          setActive(preselect(w.word, rank(w.word, recentCandidates(recent, t, w, current), 20)));
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? text.length)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          const n = matches.length;
          if (e.key === "ArrowDown" && !e.altKey && !e.metaKey && !shown) {
            e.preventDefault();
            const c = e.currentTarget.selectionStart ?? text.length;
            setCaret(c);
            setOpen(true);
            setActive(0);
          } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && shown) {
            e.preventDefault();
            const d = e.key === "ArrowDown" ? 1 : -1;
            setActive((a) => (a < 0 ? (d > 0 ? 0 : n - 1) : (a + d + n) % n));
          } else if (e.key === "Tab" && !e.shiftKey && shown) {
            e.preventDefault();
            accept((cur ?? matches[0]!).candidate);
          } else if (e.key === "Enter" && shown && cur) {
            // takes the pair; the next ⏎ applies
            e.preventDefault();
            accept(cur.candidate);
          } else if (e.key === "Escape" && shown) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setActive(-1);
          }
        }}
        placeholder={kind === "label" ? "e.g. env=prod tier-" : 'e.g. note="drained for maintenance"'}
        className={`w-full ${field} ${error ? "border-deleted" : ""}`}
      />
      {shown ? (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={`recent ${kind === "label" ? "labels" : "annotations"}`}
          className="absolute top-full left-0 z-40 mt-px max-h-64 w-full overflow-x-hidden overflow-y-auto border border-border bg-bg-elev shadow-menu"
        >
          {matches.map((m, i) => (
            <li
              key={m.candidate.label}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              // mousedown, not click: the input keeps focus
              onMouseDown={(e) => {
                e.preventDefault();
                accept(m.candidate);
              }}
              onMouseMove={() => setActive(i)}
              className={`flex cursor-default gap-3 px-2 py-0.5 ${i === active ? "bg-bg-hover text-fg" : "text-fg-muted"}`}
            >
              <span className="min-w-0 shrink truncate text-fg">{m.candidate.label}</span>
              {m.candidate.detail ? <span className="ml-auto shrink-0">{m.candidate.detail}</span> : null}
              <button
                type="button"
                tabIndex={-1}
                aria-label={`remove ${m.candidate.label}`}
                title="forget it"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const pair = m.candidate.label;
                  void bridge().removeMetaHistory(kind, pair).then((r) => setRecent(r ?? []), () => {});
                  setActive((a) => Math.min(a, matches.length - 2));
                }}
                className={`${m.candidate.detail ? "" : "ml-auto "}shrink-0 rounded border border-border px-1.5 leading-tight text-fg-muted hover:border-deleted hover:text-deleted`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
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

/** "3 pods" / "web-0, web-1 and 1 more": the marked rows a dialog acts on. */
function rowsTitle(b: Batch): string {
  const names = b.rows.map((r) => r.name);
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** Skipped rows, said under the title (scale: no replicas). */
function Skipped({ b }: { b: Batch }) {
  return b.skipped?.length ? <div className="text-fg-muted">skipped (doesn't apply): {b.skipped.join(", ")}</div> : null;
}

/**
 * Label / annotate on the marked rows: their keys with on how many rows
 * each is (a value shared by all shown, else how many values); the same
 * changes go to every row. A key set to the value all rows have is no
 * change; one that differs or is on some rows only can be set or removed.
 */
function MetaMany({ kind, batch }: { kind: "label" | "annotate"; batch: Batch }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const what = kind === "label" ? "labels" : "annotations";
  const n = batch.rows.length;
  const keys = unionMeta(batch.rows.map((r) => (kind === "label" ? r.labels : r.annotations)));
  const current = unionCurrent(keys, n);
  const parsed = parseMeta(text, current);
  const changes = "changes" in parsed ? parsed.changes : [];
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const added = changes.filter((c) => c.op === "add");

  const submit = () => {
    if ("error" in parsed) return setError(parsed.error);
    if (!hasChanges(parsed.send)) return setError(changes.length ? "no changes: every row already has that value" : "key=value sets, key- removes");
    setBusy(true);
    void submitMeta({ meta: { changes: parsed.send, text: text.trim().replace(/\s+/g, " ") } }).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };
  const take = (k: string, v: string) => {
    const token = `${k}=${quoteValue(v)}`;
    setText((t) => (t.trim() ? `${t.trimEnd()} ${token}` : token));
    setError(undefined);
    input.current?.focus();
  };

  return (
    <form
      role="dialog"
      aria-label={`${kind} ${n}`}
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
        {kind} <span className="font-semibold">{n} {batch.rows.every((r) => r.kind === batch.rows[0]!.kind) ? `${batch.rows[0]!.kind.toLowerCase()}s` : "objects"}</span>
        <span className="text-fg-muted"> · {rowsTitle(batch)}</span>
      </div>
      <Skipped b={batch} />
      <ul aria-label={what} className="flex max-h-60 flex-col overflow-auto border border-border py-0.5">
        {!keys.length && !added.length ? <li className="px-2 text-fg-muted">no {what}</li> : null}
        {keys.map((k) => {
          const shared = k.values.length === 1;
          const change = byKey.get(k.key);
          return (
            <li key={k.key} data-op={change?.op} className="flex cursor-pointer gap-1 px-2 hover:bg-bg-hover" title="take it into the field" onClick={() => take(k.key, k.values[0]!.value)}>
              <span className="w-4 shrink-0 text-fg-muted">{change?.op === "add" ? "+" : change?.op === "change" ? "~" : change?.op === "remove" ? "−" : ""}</span>
              <span className={`shrink-0 ${change?.op === "remove" ? "text-deleted line-through" : change?.op === "change" ? "text-changed" : "text-fg"}`}>{k.key}</span>
              <span className="text-fg-muted">=</span>
              <span className="truncate text-fg-muted">
                {change?.op === "change" ? <span className="text-changed">{change.value} </span> : null}
                <span className={change?.op === "change" || change?.op === "remove" ? "line-through" : ""}>{shared ? k.values[0]!.value : `${k.values.length} values`}</span>
              </span>
              <span className="ml-auto shrink-0 text-fg-muted">{k.count}/{n}</span>
            </li>
          );
        })}
        {added.map((c) => (
          <Entry key={c.key} k={c.key} v={c.value!} change={c} />
        ))}
      </ul>
      <label className="flex flex-col gap-1 text-fg-muted">
        key=value sets · key- removes · on all {n}{kind === "annotate" ? ' · "quotes" keep spaces' : ""} · ↓ recent
        <ChangesField
          input={input}
          kind={kind}
          text={text}
          current={current}
          error={!!error}
          onChange={(t) => {
            setText(t);
            setError(undefined);
          }}
        />
      </label>
      {error ? (
        <div role="alert" className="text-deleted select-text">
          {error}
        </div>
      ) : null}
      <div className="text-fg-muted">{busy ? "applying…" : `⏎ ${kind} ${n} · esc cancel`}</div>
    </form>
  );
}

/** Scale on the marked rows: one number for all, each row's current replicas listed. */
function ScaleMany({ batch }: { batch: Batch }) {
  const counts = batch.rows.map((r) => r.replicas);
  const same = counts.every((c) => c === counts[0]);
  const [text, setText] = useState(same && counts[0] !== undefined ? String(counts[0]) : "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const n = batch.rows.length;

  const submit = () => {
    const r = parseReplicas(text);
    if ("error" in r) return setError(r.error);
    if (counts.every((c) => c === r.replicas)) return setError(`all already at ${r.replicas}`);
    setBusy(true);
    void submitMeta({ scale: { replicas: r.replicas } }).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };

  return (
    <form
      role="dialog"
      aria-label={`scale ${n}`}
      className={`${frame} w-[28rem]`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setUI(S.closeOverlay);
      }}
    >
      <div className="text-fg">
        scale <span className="font-semibold">{n} workloads</span>
      </div>
      <Skipped b={batch} />
      <ul aria-label="replicas now" className="flex max-h-40 flex-col overflow-auto border border-border px-2 py-0.5">
        {batch.rows.map((r) => (
          <li key={r.key} className="flex gap-2">
            <span className="truncate text-fg">{r.name}</span>
            <span className="ml-auto text-fg-muted">{r.replicas}</span>
          </li>
        ))}
      </ul>
      <label className="flex items-baseline gap-2 text-fg-muted">
        replicas, for all
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
      <div className="text-fg-muted">{busy ? "scaling…" : `⏎ scale ${n} · esc cancel`}</div>
    </form>
  );
}
