import type { FocusContext } from "../keys/keymap";
import type { Pending } from "../transport/types";
import { leaf, neighbor, paneIds, remove, split, valid, type Direction, type Layout } from "./layout";

/** A pane's pipeline as edited in the UI; serialized to YAML for the bridge. */
export interface PaneSpec {
  context: string;
  resource: string;
  namespace: string; // "" = all
  labelSelector: string;
  grep: string;
}

export interface PaneState {
  id: string;
  spec: PaneSpec;
  /** Context name the server pane resolved spec.context to (safety rules match on it). */
  context?: string;
  /** Short-lived status message (e.g. an action refused by the safety model). */
  flash?: { text: string; error?: boolean };
  /** Set for terminal panes (exec session) instead of a table. */
  term?: Term;
  /** Server-side pane id once opened. */
  serverId?: string;
  /** An Open call is in flight. */
  opening?: boolean;
  error?: string;
  selected: number;
}

export interface Term {
  session: string;
  pod: string;
  container: string;
  context: string;
  /** Exit code or error once the session ended; the pane stays until closed. */
  exited?: string;
}

export interface Tab {
  id: string;
  layout: Layout;
  focused: string;
}

export interface Overlay {
  /** detail: yaml/diff/describe of a row; open: ⌘O; confirm: a prepared action;
   *  portforward: ports dialog for a row's pod; forwards: list of port-forwards. */
  kind: "detail" | "open" | "confirm" | "portforward" | "forwards" | "menu";
  /** detail: which view; describe is fetched separately. */
  view?: "yaml" | "describe";
  /** detail/describe: bumped by r (re-run); each value is exactly one describe call = one "look". */
  describeGen?: number;
  /** forwards, menu: highlighted entry. */
  index?: number;
  /** menu: pointer position when opened by right-click; else it's anchored to the row (rowIndex). */
  at?: { x: number; y: number };
  /** menu: the row it belongs to, for anchoring. */
  rowIndex?: number;
  pane: string;
  key?: string;
  diff?: boolean;
  /** confirm: the prepared action. */
  pending?: Pending;
  /** Focus restored when the overlay closes. */
  restore: FocusContext;
}

export interface UIState {
  tabs: Tab[];
  activeTab: number;
  panes: Record<string, PaneState>;
  focus: FocusContext;
  overlay?: Overlay;
  nextId: number;
  /** Default spec for new panes (current kube context). */
  defaults: PaneSpec;
  /** Tab ids, most recently used first (see touchTab). */
  mru: string[];
  /** ⌃⇥ switcher while ⌃ is held: index into mru of the highlighted tab. */
  switcher?: { index: number; restore: FocusContext };
}

export const initialSpec = (context = ""): PaneSpec => ({
  context,
  resource: "pods",
  namespace: "",
  labelSelector: "",
  grep: "",
});

export function initialState(context = ""): UIState {
  const spec = initialSpec(context);
  return {
    tabs: [{ id: "t1", layout: leaf("v1"), focused: "v1" }],
    activeTab: 0,
    panes: { v1: { id: "v1", spec, selected: 0 } },
    focus: "table",
    nextId: 2,
    defaults: spec,
    mru: ["t1"],
  };
}

/**
 * Keeps mru in sync with the tabs: drops closed tabs, appends new ones, and
 * moves the active tab to the front, except while the switcher is browsing
 * (only committing counts as use). A tab opening or closing mid-switch ends
 * the switcher. Applied after every state update.
 */
/**
 * The pane area's focus context follows the focused pane's kind: commands
 * only say "back to the pane" (table); a terminal pane makes it terminal.
 * Applied after every state update, like touchTab.
 */
export function paneFocus(s: UIState): UIState {
  if (s.focus !== "table" && s.focus !== "terminal") return s;
  const want = focusedPane(s)?.term ? "terminal" : "table";
  return s.focus === want ? s : { ...s, focus: want };
}

/** Opens a terminal pane for an exec session below the focused pane (⌘D direction) and focuses it. */
export function openTerminal(s: UIState, term: Term, from = activeTab(s).focused): UIState {
  const src = s.panes[from] ?? focusedPane(s);
  const id = `v${s.nextId}`;
  const next = withTab(s, (t) => ({ ...t, layout: split(t.layout, from, "column", id), focused: id }));
  return {
    ...next,
    nextId: s.nextId + 1,
    panes: { ...s.panes, [id]: { id, spec: { ...src.spec }, selected: 0, term, context: term.context } },
    focus: "terminal",
    overlay: undefined,
  };
}

/** Exec sessions no pane references any more (closed panes, closed tabs). */
export function orphanedSessions(prev: UIState, next: UIState): string[] {
  if (prev.panes === next.panes) return [];
  const live = new Set(Object.values(next.panes).map((p) => p.term?.session));
  return Object.values(prev.panes).flatMap((p) => (p.term && !live.has(p.term.session) ? [p.term.session] : []));
}

export function touchTab(s: UIState): UIState {
  const ids = s.tabs.map((t) => t.id);
  let mru = s.mru.filter((id) => ids.includes(id));
  for (const id of ids) if (!mru.includes(id)) mru.push(id);
  if (s.switcher && (mru.length !== s.mru.length || mru.some((id, i) => id !== s.mru[i]))) {
    s = switcherCancel(s);
  }
  const active = activeTab(s).id;
  if (!s.switcher && mru[0] !== active) mru = [active, ...mru.filter((id) => id !== active)];
  const same = mru.length === s.mru.length && mru.every((id, i) => id === s.mru[i]);
  return same ? s : { ...s, mru };
}

/** ⌃⇥ / ⌃⇧⇥: opens the switcher on the previous (or least recent) tab, or moves within it. */
export function switcherStep(s: UIState, delta: 1 | -1): UIState {
  const n = s.mru.length;
  if (n < 2) return s;
  const from = s.switcher ? s.switcher.index : 0;
  const index = (from + delta + n) % n;
  const restore = s.switcher?.restore ?? s.focus;
  return { ...s, switcher: { index, restore }, focus: "switcher", overlay: undefined };
}

/** Releasing ⌃ (or ⏎): activates the highlighted tab, which becomes most recent. */
export function switcherCommit(s: UIState): UIState {
  if (!s.switcher) return s;
  const id = s.mru[s.switcher.index];
  const i = s.tabs.findIndex((t) => t.id === id);
  return { ...s, switcher: undefined, focus: "table", activeTab: i >= 0 ? i : s.activeTab };
}

export function switcherCancel(s: UIState): UIState {
  return s.switcher ? { ...s, switcher: undefined, focus: s.switcher.restore } : s;
}

export const activeTab = (s: UIState): Tab => s.tabs[s.activeTab]!;
export const focusedPane = (s: UIState): PaneState => s.panes[activeTab(s).focused]!;

function withTab(s: UIState, f: (t: Tab) => Tab): UIState {
  const tabs = [...s.tabs];
  tabs[s.activeTab] = f(activeTab(s));
  return { ...s, tabs };
}

/** New pane cloned from the focused one (iTerm: new split shows the same thing). */
export function splitPane(s: UIState, dir: "row" | "column"): UIState {
  const from = focusedPane(s);
  const id = `v${s.nextId}`;
  const next = withTab(s, (t) => ({ ...t, layout: split(t.layout, t.focused, dir, id), focused: id }));
  return {
    ...next,
    nextId: s.nextId + 1,
    panes: { ...s.panes, [id]: { id, spec: { ...from.spec }, selected: 0 } },
    focus: "table",
  };
}

export function closePane(s: UIState, id = activeTab(s).focused): UIState {
  const t = activeTab(s);
  const ids = paneIds(t.layout);
  const layout = remove(t.layout, id);
  const panes = { ...s.panes };
  delete panes[id];
  if (!layout) return closeTab({ ...s, panes }, s.activeTab, false);
  const idx = ids.indexOf(id);
  const rest = paneIds(layout);
  const focused = t.focused === id ? rest[Math.max(0, idx - 1)] ?? rest[0]! : t.focused;
  return withTab({ ...s, panes, focus: "table", overlay: undefined }, () => ({ ...t, layout, focused }));
}

export function newTab(s: UIState): UIState {
  const id = `v${s.nextId}`;
  const tab: Tab = { id: `t${s.nextId}`, layout: leaf(id), focused: id };
  return {
    ...s,
    tabs: [...s.tabs, tab],
    activeTab: s.tabs.length,
    nextId: s.nextId + 1,
    panes: { ...s.panes, [id]: { id, spec: { ...focusedPane(s).spec }, selected: 0 } },
    focus: "table",
    overlay: undefined,
  };
}

/** Closes a tab; the last tab is replaced by a fresh one so the app always has a pane. */
export function closeTab(s: UIState, index = s.activeTab, dropPanes = true): UIState {
  const panes = { ...s.panes };
  if (dropPanes) for (const id of paneIds(s.tabs[index]!.layout)) delete panes[id];
  const tabs = s.tabs.filter((_, i) => i !== index);
  if (tabs.length === 0) {
    const id = `v${s.nextId}`;
    return {
      ...s,
      tabs: [{ id: `t${s.nextId}`, layout: leaf(id), focused: id }],
      activeTab: 0,
      nextId: s.nextId + 1,
      panes: { ...panes, [id]: { id, spec: { ...s.defaults }, selected: 0 } },
      focus: "table",
      overlay: undefined,
    };
  }
  return { ...s, tabs, panes, activeTab: Math.min(index, tabs.length - 1), focus: "table", overlay: undefined };
}

export function cycleTab(s: UIState, delta: number): UIState {
  const n = s.tabs.length;
  return { ...s, activeTab: (s.activeTab + delta + n) % n, overlay: undefined, focus: "table" };
}

/** ⌘1–⌘8: that tab; ⌘9: the last tab. Out of range: unchanged. */
export function gotoTab(s: UIState, n: number): UIState {
  const i = n === 9 ? s.tabs.length - 1 : n - 1;
  if (i < 0 || i >= s.tabs.length) return s;
  return { ...s, activeTab: i, overlay: undefined, focus: "table", switcher: undefined };
}

/** The ⌘-digit that reaches tab i, if any (⌘9 is the last tab). */
export function tabShortcut(i: number, count: number): number | undefined {
  if (i < 8) return i + 1;
  return i === count - 1 ? 9 : undefined;
}

/**
 * Applies a layout rearranged by the user in dockview (divider drag, pane
 * drag-and-drop). Only arrangements of the same panes are accepted; adding
 * and removing panes always goes through the store's own commands.
 */
export function setLayout(s: UIState, layout: Layout): UIState {
  const t = activeTab(s);
  const have = paneIds(t.layout).sort();
  const got = paneIds(layout).sort();
  if (!valid(layout) || have.length !== got.length || have.some((id, i) => id !== got[i])) return s;
  return withTab(s, () => ({ ...t, layout }));
}

export function cyclePane(s: UIState, delta: number): UIState {
  const ids = paneIds(activeTab(s).layout);
  const i = ids.indexOf(activeTab(s).focused);
  const focused = ids[(i + delta + ids.length) % ids.length]!;
  return withTab({ ...s, focus: "table" }, (t) => ({ ...t, focused }));
}

/** ⌘⌥arrows: focus the pane in that direction; stays put at the edge. */
export function focusDirection(s: UIState, dir: Direction): UIState {
  const t = activeTab(s);
  const id = neighbor(t.layout, t.focused, dir);
  return id ? withTab({ ...s, focus: "table" }, (x) => ({ ...x, focused: id })) : s;
}

export function focusPane(s: UIState, id: string): UIState {
  if (!paneIds(activeTab(s).layout).includes(id)) return s;
  return withTab(s, (t) => ({ ...t, focused: id }));
}

export function updatePane(s: UIState, id: string, f: (p: PaneState) => PaneState): UIState {
  const p = s.panes[id];
  return p ? { ...s, panes: { ...s.panes, [id]: f(p) } } : s;
}

export function moveSelection(s: UIState, delta: number | "first" | "last", total: number): UIState {
  const p = focusedPane(s);
  let sel = delta === "first" ? 0 : delta === "last" ? total - 1 : p.selected + delta;
  sel = Math.max(0, Math.min(total - 1, sel));
  return updatePane(s, p.id, (x) => ({ ...x, selected: Math.max(0, sel) }));
}

export function openOverlay(s: UIState, o: Omit<Overlay, "restore">): UIState {
  const focus: FocusContext = o.kind === "detail" ? "detail" : o.kind === "confirm" ? "confirm" : o.kind === "forwards" ? "forwards" : o.kind === "menu" ? "menu" : "dialog";
  return { ...s, overlay: { ...o, restore: s.focus }, focus };
}

export function closeOverlay(s: UIState): UIState {
  if (!s.overlay) return s;
  return { ...s, overlay: undefined, focus: s.overlay.restore };
}

/** YAML pipeline for a pane (see internal/pipeline). JSON is valid YAML. */
export function pipelineYAML(spec: PaneSpec): string {
  const source: Record<string, string> = { resource: spec.resource };
  if (spec.context) source.cluster = spec.context;
  if (spec.namespace) source.namespace = spec.namespace;
  if (spec.labelSelector) source.labelSelector = spec.labelSelector;
  const p: Record<string, unknown> = { source };
  if (spec.grep) p.stages = [{ grep: spec.grep }];
  return JSON.stringify(p);
}

/** Server panes referenced by `prev` but no longer by `next` (UI pane closed or source replaced). */
export function orphanedServerPanes(prev: UIState, next: UIState): string[] {
  if (prev.panes === next.panes) return [];
  const live = new Set(Object.values(next.panes).map((p) => p.serverId));
  return Object.values(prev.panes).flatMap((p) => (p.serverId && !live.has(p.serverId) ? [p.serverId] : []));
}

export const sameSource = (a: PaneSpec, b: PaneSpec) =>
  a.context === b.context && a.resource === b.resource && a.namespace === b.namespace && a.labelSelector === b.labelSelector;
