import { useEffect, useId, useMemo, useState } from "react";
import { openCluster } from "../commands";
import { chord, keyFor, prettyKey } from "../keys/keymap";
import { useConfig } from "../store/config";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import type { ClusterEntry, ClusterList } from "../transport/types";
import { item as listItem, items as listItems, keepIndex, type Item, type Plane } from "./clusterList";
import { Badges } from "./Pane";

/** ⌘⇧O: a cluster for the focused pane, a split below or a new tab. */
export function ClusterPicker() {
  const overlay = useUI((s) => s.overlay);
  if (overlay?.kind !== "clusters") return null;
  // mounted per open: the list is read anew, the text starts empty
  return <Picker paneId={overlay.pane} />;
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e);

const planes: { value: Plane; label: string }[] = [
  { value: "shoot", label: "shoot" },
  { value: "controlPlane", label: "control plane" },
];
// where a pick opens, by the jump menu's keys (⏎ here, ⇧⏎ split, ⌘⏎ tab: rebindable together)
const runs: [string, S.ClusterTarget][] = [
  ["menu.run", "here"],
  ["menu.runSplit", "pane"],
  ["menu.runTab", "tab"],
];

/**
 * One field above the list. Empty, the list holds the recently opened
 * clusters (and gardenctl sessions' targets), the latest first, then the
 * gardens; typing ranks them, a text gardenctl's patterns match (a
 * dashboard URL, an API host, shoot--project--name) adds its targets on top,
 * a path (/…, ~/…) a kubeconfig file. ↑/↓ move; as in the ⌘J menu, ⏎ opens
 * in the focused pane, ⇧⏎ in a split below, ⌘⏎ in a new tab (a click, ⇧-click,
 * ⌘-click too); a shoot or its control plane as the toggle says (⇥), Esc closes. It opens listing nothing,
 * with ⌘O over it. Resolving a Gardener target may take a login (the
 * garden's exec plugin): the dialog stays until it's done or failed.
 */
function Picker({ paneId }: { paneId: string }) {
  const id = useId();
  const [list, setList] = useState<ClusterList>();
  const [text, setText] = useState("");
  const [matches, setMatches] = useState<ClusterEntry[]>([]);
  // a shoot name in several projects: the choices replace the list
  const [choices, setChoices] = useState<ClusterEntry[]>();
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<string>();
  const bindings = useConfig((s) => s.bindings);
  const keyOf = (cmd: string) => keyFor(bindings, cmd, "menu");
  // a shoot line opens the shoot or its control plane: shoot at every open
  const [plane, setPlane] = useState<Plane>("shoot");
  const [error, setError] = useState<string>();
  const now = useMemo(() => new Date(), [list]);

  const load = () => bridge().clusters().then(setList, (e: unknown) => setError(errorText(e)));
  useEffect(() => void load(), []);
  // the patterns are matched in Go (gardenctl's regexps); a later answer for an older text is dropped
  useEffect(() => {
    let live = true;
    if (!text.trim()) return setMatches([]);
    bridge()
      .matchTarget(text)
      .then(
        (m) => live && setMatches(m),
        () => live && setMatches([]),
      );
    return () => {
      live = false;
    };
  }, [text]);

  const shown: Item[] = useMemo(
    () =>
      choices
        ? choices.map((e) => ({ ...listItem(e, plane, now), detail: `project ${e.project || e.namespace?.replace(/^garden-/, "")} · ${e.garden}` }))
        : listItems(list, matches, text, now, plane),
    [list, matches, text, choices, now, plane],
  );
  // a new list (typed text, matches arriving, a forgotten entry): the highlight stays on its
  // entry while the text is empty (browsing), else goes to the best pickable match; a toggled
  // plane keeps it on its line
  const [prev, setPrev] = useState({ shown, plane });
  if (prev.shown !== shown) {
    setPrev({ shown, plane });
    setActive(keepIndex(text.trim() && prev.plane === plane ? undefined : prev.shown[active], shown));
  }
  const cur = shown[active];

  const close = () => setUI(S.closeOverlay);
  const pick = async (it: Item | undefined, to: S.ClusterTarget) => {
    if (!it || busy) return;
    if (it.entry.disabled) return setError(it.entry.disabled);
    setError(undefined);
    setBusy(it.entry.garden ? `resolving ${it.label}… (the garden may ask to log in)` : `opening ${it.label}…`);
    try {
      const o = await bridge().openCluster(it.entry);
      if (o.choices?.length) {
        setChoices(o.choices);
        setActive(0);
        return;
      }
      if (useUI.getState().overlay?.kind !== "clusters") return; // closed meanwhile
      close();
      await openCluster(paneId, o.cluster, o.namespace ?? "", to);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };
  const forget = (it: Item) => {
    bridge()
      .forgetCluster(it.row)
      .then(load, (e: unknown) => setError(errorText(e)));
  };
  const move = (d: number) => {
    const n = shown.length;
    if (n) setActive((a) => (a + d + n) % n);
  };

  const hint = busy ?? error ?? (list?.errors?.length ? list.errors.join("; ") : text.trim() && !shown.length ? "nothing matches: gardenctl's patterns are in ~/.garden/gardenctl-v2.yaml" : undefined);
  return (
    <div
      role="dialog"
      aria-label="open cluster"
      className="absolute top-16 left-1/2 z-30 flex max-h-[70vh] w-[44rem] max-w-[90vw] -translate-x-1/2 flex-col border border-accent bg-bg-elev shadow-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          if (choices) return setChoices(undefined);
          close();
        }
      }}
    >
      <input
        role="combobox"
        aria-label="cluster"
        aria-expanded={shown.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={cur ? `${id}-${active}` : undefined}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder="recent cluster, gardener dashboard URL, shoot--project--name, kubeconfig path"
        className="m-2 rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setChoices(undefined);
          setError(undefined);
        }}
        onKeyDown={(e) => {
          const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
          if (e.key === "ArrowDown" || (ctrl && e.key === "n")) {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp" || (ctrl && e.key === "p")) {
            e.preventDefault();
            move(-1);
          } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            setActive(e.key === "ArrowUp" ? 0 : Math.max(0, shown.length - 1));
          } else if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            setPlane((p) => (p === "shoot" ? "controlPlane" : "shoot"));
          } else {
            const c = chord(e);
            const to = runs.find(([cmd]) => keyOf(cmd) === c)?.[1] ?? (c === "Enter" ? "here" : undefined);
            if (!to) return;
            e.preventDefault();
            e.stopPropagation();
            void pick(cur, to);
          }
        }}
      />
      {hint && (
        <div role="status" aria-label="cluster status" className={`mx-2 mb-1 ${error ? "text-deleted" : "text-fg-muted"} select-text`}>
          {hint}
        </div>
      )}
      {choices && <div className="mx-2 mb-1 text-fg-muted">the shoot exists in several projects: pick one (esc: back)</div>}
      <ul id={`${id}-list`} role="listbox" aria-label="clusters" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto border-t border-border">
        {shown.map((it, i) => (
          <li
            key={`${i}\u0000${it.label}\u0000${it.detail}`}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            aria-disabled={it.entry.disabled ? true : undefined}
            title={it.entry.disabled ?? it.entry.name}
            ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            onMouseDown={(e) => {
              e.preventDefault();
              setActive(i);
              void pick(it, e.shiftKey ? "pane" : e.metaKey ? "tab" : "here");
            }}
            onMouseMove={() => setActive(i)}
            className={`flex cursor-default items-center gap-3 px-2 py-0.5 ${i === active ? "bg-bg-hover text-fg" : "text-fg-muted"} ${it.entry.disabled ? "opacity-50" : ""}`}
          >
            <span className="min-w-0 shrink truncate text-fg">{highlight(it.label, it.hits)}</span>
            <span className="flex shrink-0 gap-1">
              <Badges rule={it.entry.rule} />
            </span>
            <span className="min-w-0 shrink-[1000] truncate">{it.detail}</span>
            {it.entry.disabled && <span className="shrink-0 italic">{it.entry.disabled}</span>}
            {it.row.from === "recent" && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={`forget ${it.label}`}
                title="forget"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  forget(it);
                }}
                className="ml-auto shrink-0 rounded border border-border px-1.5 leading-tight text-fg-muted hover:border-deleted hover:text-deleted"
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 border-t border-border px-2 py-0.5 text-fg-muted">
        <Toggle label="gardener shoot" keyHint="⇥" options={planes} value={plane} onChange={setPlane} dim={!cur?.row.shoot} />
        <span aria-label="keys" className="ml-auto">
          {pretty(keyOf("menu.run"), "⏎")} here · {pretty(keyOf("menu.runSplit"), "⇧⏎")} split · {pretty(keyOf("menu.runTab"), "⌘⏎")} tab · esc close
        </span>
      </div>
    </div>
  );
}

/** A segmented toggle in the footer: clicked, or cycled by its key in the field. */
function Toggle<T extends string>({ label, keyHint, options, value, onChange, dim }: { label: string; keyHint: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; dim?: boolean }) {
  return (
    <span role="radiogroup" aria-label={label} title={`${label} (${keyHint})`} className={`flex items-center gap-1 ${dim ? "opacity-50" : ""}`}>
      <span className="mr-0.5">{keyHint}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={-1}
          // the field keeps the focus
          onMouseDown={(e) => {
            e.preventDefault();
            onChange(o.value);
          }}
          className={`rounded border px-1.5 leading-tight ${o.value === value ? "border-accent text-fg" : "border-border hover:text-fg"}`}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

const pretty = (key: string | undefined, fallback: string) => (key ? prettyKey(key) : fallback);

function highlight(text: string, hits: number[]) {
  if (!hits.length) return text;
  const set = new Set(hits);
  return [...text].map((ch, i) =>
    set.has(i) ? (
      <b key={i} className="font-normal text-accent">
        {ch}
      </b>
    ) : (
      ch
    ),
  );
}
