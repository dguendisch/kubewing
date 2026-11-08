import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeMenu, rowLocators, type Anchor } from "../actions/anchor";
import { firstJumpable, jumpItems, jumpable, sectionTitle, useJump } from "../actions/jump";
import { runJump } from "../commands";
import { useConfig } from "../store/config";
import { bridge, setUI, useUI } from "../store/store";
import { prettyKey } from "../keys/keymap";

/**
 * ⌘J: where the selected row leads — its namespace, its owners up the chain,
 * what it owns and refers to; from its YAML first what the field at the
 * cursor refers to. Go computes every entry as a pipeline (internal/relations);
 * ⏎ shows it in this pane (Esc in the table goes back), ⇧⏎ in a split
 * below. The owned scan (any kind owned by this UID) runs only on request.
 * A Gardener row of a garden first lists its clusters (shoot, control plane,
 * seed), opened as a ⌘P pick: resolved only when chosen, ⌘⏎ in a new tab.
 */
export function JumpMenu() {
  const overlay = useUI((s) => s.overlay);
  const serverId = useUI((s) => (s.overlay ? s.panes[s.overlay.pane]?.serverId : undefined));
  if (overlay?.kind !== "jump" || !serverId || !overlay.key) return null;
  return <Menu key={overlay.key} serverId={serverId} rowKey={overlay.key} />;
}

function Menu({ serverId, rowKey }: { serverId: string; rowKey: string }) {
  const index = useUI((s) => s.overlay?.index ?? 0);
  const at = useUI((s) => s.overlay?.at);
  const rowIndex = useUI((s) => s.overlay?.rowIndex);
  // opened from an object's YAML: the text and cursor line, read once (the menu is for that moment)
  const [field] = useState(() => useUI.getState().overlay?.yaml);
  const el = useRef<HTMLDivElement>(null);
  const { rel, items, scanning, resolving } = useJump();
  const [error, setError] = useState<string>();
  const bindings = useConfig((s) => s.bindings);
  const keyOf = (cmd: string) => {
    const b = bindings.find((x) => x.command === cmd && (!x.when?.length || x.when.includes("menu")));
    return b && prettyKey(b.key);
  };

  // the relations, then (on request) the owned scan; both keep the highlight by entry id
  const select = (next: ReturnType<typeof jumpItems>, keepId?: string) => {
    const i = keepId ? next.findIndex((x) => x.id === keepId && jumpable(x)) : -1;
    const index = i >= 0 ? i : firstJumpable(next);
    setUI((s) => (s.overlay?.kind === "jump" ? { ...s, overlay: { ...s.overlay, index } } : s));
  };
  useEffect(() => {
    useJump.setState({ items: [], rel: undefined }, true);
    let live = true;
    // the field section (looked up from the YAML at the cursor) and the relations come together: the highlight starts once
    const fieldRels = field
      ? bridge()
          .fieldRelations(serverId, field.text, field.line)
          .catch((e: unknown) => [{ id: "field:error", section: "field" as const, label: "references at the cursor", gone: String((e as Error)?.message ?? e) }])
      : Promise.resolve(undefined);
    Promise.all([bridge().relations(serverId, rowKey), fieldRels])
      .then(
        ([r, f]) => {
          if (!live) return;
          const scan = () => runScan(serverId, rowKey, select);
          const next = jumpItems(r, { field: f });
          useJump.setState({ rel: r, field: f, items: next, scan }, true);
          select(next);
        },
        (e) => live && setError(String((e as Error)?.message ?? e)),
      );
    return () => {
      live = false;
      useJump.setState({ items: [], rel: undefined }, true);
    };
  }, [serverId, rowKey]);

  // anchored like the ⌘⏎ menu: to the pointer (right-click), else below the row
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean }>();
  useLayoutEffect(() => {
    const m = el.current;
    if (!m) return;
    const loc = rowLocators.get(serverId);
    const box = rowIndex !== undefined ? loc?.row(rowIndex) : undefined;
    const viewport = loc?.viewport();
    const anchor: Anchor | undefined = at
      ? { kind: "point", ...at }
      : box && viewport
        ? { kind: "row", row: box, viewport }
        : viewport
          ? { kind: "row", row: { ...viewport, height: 0 }, viewport }
          : undefined;
    setPos(anchor && placeMenu(anchor, { width: m.offsetWidth, height: m.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [serverId, rowIndex, at?.x, at?.y, items.length, !!error]);

  const title = rel ? `${rel.kind.toLowerCase()} ${rel.name}${rel.namespace ? ` · ${rel.namespace}` : ""}` : "…";
  return (
    <div
      ref={el}
      role="menu"
      aria-label={`jump from ${rel?.name ?? "…"}`}
      aria-busy={!rel || scanning || !!resolving || undefined}
      className={`absolute z-40 flex w-96 flex-col border border-accent bg-bg-elev py-1 shadow-menu ${pos ? "" : "top-24 left-1/2 -translate-x-1/2"}`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div className="flex border-b border-border px-3 pb-1 text-fg-muted">
        <span className="truncate">
          jump from <span className="text-fg">{title}</span>
        </span>
        <span className="ml-auto shrink-0 pl-2">
          ⏎ here · {keyOf("menu.runSplit") ?? "⇧⏎"} split
          {rel?.clusters?.length ? ` · ${keyOf("menu.runTab") ?? "⌘⏎"} tab` : ""}
        </span>
      </div>
      {error ? <div role="alert" className="px-3 py-0.5 text-deleted">{error}</div> : null}
      {!rel && !error ? <div className="px-3 py-0.5 text-fg-muted">{field ? "looking up references and owners…" : "looking up owners…"}</div> : null}
      {items.map((it, i) => (
        <div key={it.id}>
          {i === 0 || items[i - 1]!.section !== it.section ? (
            <div role="separator" aria-label={sectionTitle[it.section]} className={`px-3 text-[11px] text-fg-muted uppercase ${i > 0 ? "mt-1 border-t border-border pt-1" : ""}`}>
              {sectionTitle[it.section]}
            </div>
          ) : null}
          <button
            role="menuitem"
            aria-disabled={it.disabled ? true : undefined}
            title={it.disabled ?? it.note}
            data-active={i === index || undefined}
            className={`flex w-full items-baseline gap-2 py-0.5 pr-3 text-left ${i === index ? "bg-bg-hover" : ""} ${it.disabled ? "text-fg-muted" : "text-fg"}`}
            style={{ paddingLeft: `${0.75 + (it.indent ?? 0) * 0.75}rem` }}
            onMouseMove={() => !it.disabled && setUI((s) => (s.overlay?.kind === "jump" && s.overlay.index !== i ? { ...s, overlay: { ...s.overlay, index: i } } : s))}
            onClick={(e) => void runJump(i, e.shiftKey ? "pane" : e.metaKey && it.cluster ? "tab" : "here")}
          >
            <span className="truncate">
              {it.indent ? "↑ " : ""}
              <Label label={it.label} type={it.type} muted={!!it.disabled} />
            </span>
            {it.disabled ? <span className="truncate text-[11px]">· {it.disabled}</span> : null}
            {!it.disabled && it.note ? <span className="truncate text-[11px] text-fg-muted">· {it.note}</span> : null}
            <span className="ml-auto shrink-0 text-fg-muted">{it.detail}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * An entry's label with its resource type set apart from the name, in the
 * color of the resource in a pane's header (a disabled entry's stays muted).
 */
function Label({ label, type, muted }: { label: string; type?: string; muted: boolean }) {
  if (!type || !label.startsWith(type)) return <>{label}</>;
  return (
    <>
      <span data-part="type" className={muted ? undefined : "text-accent"}>
        {type}
      </span>
      {label.slice(type.length)}
    </>
  );
}

/**
 * The owned scan. For a cluster-scoped owner it lists every type in every
 * namespace, so the first ⏎ only asks (the entry says so) and the second runs it.
 */
function runScan(serverId: string, rowKey: string, select: (items: ReturnType<typeof jumpItems>, keepId?: string) => void) {
  const st = useJump.getState();
  if (!st.rel || st.scanning || st.scanned) return;
  const update = (patch: Partial<typeof st>) => {
    const cur = { ...useJump.getState(), ...patch };
    const items = jumpItems(cur.rel!, cur);
    useJump.setState({ ...patch, items });
    return items;
  };
  if (st.rel.scanAll && !st.scanAsked) return void select(update({ scanAsked: true }), "scan");
  select(update({ scanning: true, scanError: undefined }), "scan");
  bridge()
    .ownedScan(serverId, rowKey)
    .then(
      (r) => {
        if (useJump.getState().rel !== st.rel) return; // menu closed or moved on
        select(update({ scanning: false, scanned: r }));
      },
      (e) => {
        if (useJump.getState().rel !== st.rel) return;
        select(update({ scanning: false, scanError: String((e as Error)?.message ?? e) }), "scan");
      },
    );
}
