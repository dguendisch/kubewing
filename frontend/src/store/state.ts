import type { FocusContext } from "../keys/keymap";
import { leaf, paneIds, remove, split, type Layout } from "./layout";

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
  /** Server-side pane id once opened. */
  serverId?: string;
  /** An Open call is in flight. */
  opening?: boolean;
  error?: string;
  selected: number;
}

export interface Tab {
  id: string;
  layout: Layout;
  focused: string;
}

export interface Overlay {
  kind: "detail" | "open";
  pane: string;
  key?: string;
  diff?: boolean;
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
  };
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

export function cyclePane(s: UIState, delta: number): UIState {
  const ids = paneIds(activeTab(s).layout);
  const i = ids.indexOf(activeTab(s).focused);
  const focused = ids[(i + delta + ids.length) % ids.length]!;
  return withTab({ ...s, focus: "table" }, (t) => ({ ...t, focused }));
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
  return { ...s, overlay: { ...o, restore: s.focus }, focus: o.kind === "detail" ? "detail" : "dialog" };
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
