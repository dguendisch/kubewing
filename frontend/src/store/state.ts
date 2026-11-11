import type { CommandId, FocusContext } from "../keys/keymap";
import type { Batch, ColumnChoices, ConfigFile, ContextList, DebugOptions, DecodeLevel, EditDecoded, EditPreview, FieldHistory, JumpTarget, LogsScope, MetaChanges, OpsPodDefaults, OpsPodOptions, Pending } from "../transport/types";
import type { ContainerChoice } from "../components/containers";
import type { CellChoice } from "../grid/cells";
import type { Place } from "../editor/Viewer";
import { grid, insert, insertEdge, leaf, MIN_PANE_PX, neighbor, paneIds, remove, resize, sameShape, split, stackBelow, valid, type Direction, type Layout, type Side } from "./layout";

/** A pane's pipeline as edited in the UI; serialized to YAML for the bridge. */
export interface PaneSpec {
  context: string;
  resource: string;
  namespace: string; // "" = all
  labelSelector: string;
  /** Server-side field selector (a jump to a node's pods: spec.nodeName=…); "" = none. */
  fieldSelector?: string;
  grep: string;
  /** CEL filter over the object `o` ("" = none). */
  filter: string;
  /** The filter a jump set (o.metadata.name == …): ⌘O drops the filter while it's still this one. */
  jumpFilter?: string;
  /** Hides healthy objects, as the health rule for their kind says (built in or health.yaml; kinds without one pass). */
  hideHealthy?: boolean;
  /** Sorts by a column (a header click): its name, "-" in front = descending; unset = kubectl's order. */
  sort?: string;
}

/** A header click: by that column ascending, then descending, then back to kubectl's order. */
export function nextSort(current: string | undefined, column: string): string | undefined {
  if (current === column) return `-${column}`;
  if (current === `-${column}`) return undefined;
  return column;
}

/** The sorted column and its direction, from PaneSpec.sort. */
export function sortOf(sort: string | undefined): { column: string; desc: boolean } | undefined {
  if (!sort) return undefined;
  return sort.startsWith("-") ? { column: sort.slice(1), desc: true } : { column: sort, desc: false };
}

export interface PaneState {
  id: string;
  spec: PaneSpec;
  /** Context name the server pane resolved spec.context to (safety rules match on it). */
  context?: string;
  /** Kind the server pane resolved spec.resource to ("Pod"). */
  kind?: string;
  /** Short-lived status message (e.g. an action refused by the safety model). */
  flash?: { text: string; error?: boolean };
  /** Set for terminal panes (exec session) instead of a table. */
  term?: Term;
  /** Set for log panes (multi-pod tail) instead of a table. */
  logs?: Logs;
  /** Server-side pane id once opened. */
  serverId?: string;
  /** An Open call is in flight. */
  opening?: boolean;
  error?: string;
  selected: number;
  /** The row (key) a range of marked rows extends from (⇧↓, ⇧-click); set by the last toggle or the first extend. */
  markAnchor?: string;
  /** Navigation history (⌘J jumps, ⌘O to a new source), as in a browser: the views before (⌘←) and, after going back, after (⌘→) this one; newest last. */
  back?: HistoryEntry[];
  forward?: HistoryEntry[];
  /** After moving through the history: the row to select again once the pane shows it (by key). */
  reselect?: string;
  /** Resource type the server pane resolved to (pods, deployments.apps): its column settings apply. */
  type?: string;
  /** The type's plural exists in several groups: only the qualified name tells them apart. */
  ambiguous?: boolean;
  /** A name given to the pane (⌘I), shown in its header; it names the tab too while the tab has none. */
  name?: string;
  /** Shows one object (YAML, diff, describe) instead of its table: over it (⏎) or as a pane of its own (⇧⏎). */
  object?: ObjectView;
  /**
   * serverId is another pane's (the table a split object view came from):
   * it holds it open, but never changes it (a new spec opens one of its own).
   */
  leased?: boolean;
  /** A listing lists again every this many seconds (the status line's auto refresh); unset = only on ⌘R. */
  autoRefresh?: number;
}

/**
 * A pane's object view: the YAML, the diff of a version against the one
 * before, or kubectl describe, of one row (by key). Opened over the pane's
 * table (⏎: a step in its history, Esc or ⌘← back) or in a split of its own
 * (⇧⏎: Esc closes it), where it can follow the table's selection. Decoding
 * and editing happen in it.
 */
export interface ObjectView {
  key: string;
  view: "yaml" | "describe";
  diff?: boolean;
  /** diff: the version shown (diffed against the one before); unset = follow the newest. */
  version?: number;
  /** describe: bumped by r (re-run); each value is exactly one describe call = one "look". */
  describeGen?: number;
  /** "pod/web-0" once loaded, for the tab and the history list. */
  title?: string;
  /** Opened in a split (⇧⏎): there's no table under it. */
  split?: boolean;
  /** split: the table pane it came from; its selection can be followed. */
  from?: string;
  /** split: shows the row selected in `from`, as it moves. */
  follow?: boolean;
  /** Why following stopped on its own (the table closed, or shows another source now). */
  followOff?: string;
  /** The field under the cursor decoded (⏎), level by level (Esc back up). */
  decode?: DecodeState;
  /** The object in the editor (e), then the server's dry-run diff. */
  edit?: EditState;
  /** Opened by the editor (e in the table, ⇧E): the editor closing goes back to the table, or closes the split. */
  viaEdit?: boolean;
}

/** A view in a pane's jump history: its spec, the row selected there, and the object shown over it, if any. */
export interface HistoryEntry {
  spec: PaneSpec;
  /** Row key (the row index moves with the data). */
  key?: string;
  object?: ObjectView;
}

/** History depth per pane and direction. */
export const historyLimit = 50;

export interface Term {
  session: string;
  pod: string;
  container: string;
  context: string;
  /** A debug container (kubectl debug), not an exec. */
  debug?: { image: string; target?: string };
  /** An ops pod on a node (pod = the ops pod, container its one container). */
  ops?: { node: string; namespace: string; image: string; settings?: string };
  /** A local shell with the context's kubeconfig (pod and container unused); namespace unset = the context's own. */
  local?: { namespace?: string };
  /** Exit code or error once the session ended; the pane stays until closed. */
  exited?: string;
  /** Set on the first keystroke: a shell that dies before it is ever used failed on its own. */
  typed?: boolean;
  /** The find bar (⌘F); kept while closed, so ⌘F reopens with the last query. */
  find?: TermFind;
}

/** A multi-pod log tail pane (stern-like). Its lines live in logs/buffer.ts. */
export interface Logs {
  session: string;
  /** What is tailed, for the header ("api-0", "deploy/etcd", "pods · ns app=x"). */
  title: string;
  context: string;
  /** The live filter (fzf-like grep terms); hides non-matching lines. */
  filter: string;
  /** Show the RFC 3339 timestamp per line. */
  timestamps: boolean;
  /** Started following (new lines stream in); false = the logs were read once. */
  follow: boolean;
  /** The previous, terminated instance's logs (kubectl logs -p), read once. */
  previous?: boolean;
  /** Prefix lines with their pod/container (off for a single-pod tail is still on; kept for the toggle). */
  prefix: boolean;
  /** Exit text once the session ended; the pane stays until closed. */
  exited?: string;
  /** The find bar (⌘F), as a terminal's. */
  find?: TermFind;
}

export interface TermFind {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const noFind: TermFind = { open: false, query: "", caseSensitive: false, wholeWord: false, regex: false };

/** ⌘F in a terminal pane: opens its find bar (or refocuses it) and focuses the field. */
export function openFind(s: UIState): UIState {
  const p = focusedPane(s);
  if (!p?.term) return s;
  const find = { ...(p.term.find ?? noFind), open: true };
  return { ...updatePane(s, p.id, (q) => ({ ...q, term: { ...q.term!, find } })), focus: "termfind" };
}

/** Esc in the find field: closes the bar, focus back to the shell (or the ended pane). */
export function closeFind(s: UIState): UIState {
  const p = focusedPane(s);
  if (!p?.term?.find?.open) return s.focus === "termfind" ? { ...s, focus: "terminal" } : s;
  const next = updatePane(s, p.id, (q) => ({ ...q, term: { ...q.term!, find: { ...q.term!.find!, open: false } } }));
  return { ...next, focus: "terminal" }; // paneFocus turns it into "ended" for a finished session
}

/** A click into the terminal: the shell has the keys again (⏎ included); an open find bar stays, with its highlights. */
export function focusTerminal(s: UIState, paneId: string): UIState {
  const next = focusPane(s, paneId);
  return next.focus === "termfind" ? { ...next, focus: "terminal" } : next; // paneFocus turns it into "ended" for a finished session
}

export function updateFind(s: UIState, paneId: string, f: (x: TermFind) => TermFind): UIState {
  return updatePane(s, paneId, (q) => (q.term ? { ...q, term: { ...q.term, find: f(q.term.find ?? noFind) } } : q));
}

export interface Tab {
  id: string;
  layout: Layout;
  focused: string;
  /** ⌘⇧⏎: this pane fills the tab, the others are hidden (not closed); always the focused one. */
  maximized?: string;
  /** A name given to the tab (⌘⇧I), instead of the focused pane's resource and namespace. */
  name?: string;
}

export interface Overlay {
  /** open: ⌘O; clusters: ⌘⇧O (a cluster for the pane or a new tab); confirm: a prepared action;
   *  portforward: ports dialog for a row's pod or service; forwards: list of port-forwards;
   *  help: the keyboard cheat sheet; closeTab: ⌘W on a tab with several panes, or unsaved edits;
   *  closePane: closing a pane with unsaved edits;
   *  container: which container a prepared exec enters;
   *  debug: image, target and profile of a prepared debug container;
   *  meta: the labels or annotations of a prepared label / annotate, or the replicas of a prepared scale;
   *  opspod: node, image and host access of an ops pod (prepared on submit);
   *  jump: where the pane can go from a row (namespace, owners, owned);
   *  history: a pane's back or forward history (holding its ← / → button);
   *  error: the full text of an error in the status line (a click on it);
   *  columns: the pane's columns (its resource type's), -o wide and custom ones;
   *  cells: which of the selected row's cells to copy;
   *  field: a field's values over time (⇧H in an object view);
   *  renameTab / renamePane: the name field of a tab (tabId) or pane, in place;
   *  logs: containers, history and follow of a log tail, before it starts;
   *  update: the release notes of a new version;
   *  config: config.yaml in an editor (⌘,), the reference beside it. */
  kind: "open" | "clusters" | "confirm" | "portforward" | "forwards" | "menu" | "help" | "closeTab" | "closePane" | "container" | "debug" | "meta" | "opspod" | "jump" | "history" | "error" | "columns" | "cells" | "field" | "renameTab" | "renamePane" | "logs" | "update" | "config";
  /** history: which one. */
  dir?: "back" | "forward";
  /** clusters: where it opens at first, in place of the last choice (a broken pane's hint: here). */
  where?: ClusterTarget;
  /** error: which error (the source's, the CEL filter's, the pane's message). */
  view?: "source" | "filter" | "skipped" | "flash";
  /** error: its full text. */
  text?: string;
  /** forwards, menu, container, jump, history, cells: highlighted entry. */
  index?: number;
  /** menu, jump, cells: pointer position when opened by right-click; else it's anchored to the row (rowIndex). history: below its button. */
  at?: { x: number; y: number };
  /** menu, jump, cells: the row it belongs to, for anchoring. */
  rowIndex?: number;
  /** menu: the column right-clicked (copy cell… highlights it). */
  column?: string;
  /** cells: the row's cells to pick from. */
  cells?: CellChoice[];
  /** jump: from an object's YAML (view, diff or editor), its text and the cursor line: the field section's references. */
  yaml?: { text: string; line: number };
  pane: string;
  key?: string;
  /** closeTab: the tab to close (not the index: tabs move while the dialog is open). renameTab: the tab named. */
  tabId?: string;
  /** confirm, container: the prepared action. */
  pending?: Pending;
  /** confirm, debug, meta: the action prepared for the marked rows (in place of pending). */
  batch?: Batch;
  /** container: the pod's containers to pick from. */
  containers?: ContainerChoice[];
  /** confirm: the container a prepared exec enters ("" or unset = the pod's default). */
  container?: string;
  /** confirm: the options of a prepared debug. */
  debug?: DebugOptions;
  /** confirm: the changes of a prepared label / annotate (and the dialog's text, for the summary). */
  meta?: { changes: MetaChanges; text: string };
  /** confirm: the replicas of a prepared scale (and the current ones). */
  scale?: { replicas: number; from?: number };
  /** opspod: the node prefilled from the selected row; confirm: the options of a prepared ops pod. */
  node?: string;
  ops?: OpsPodOptions;
  /** opspod: the dialog's initial values, loaded before it opens. */
  opsDefaults?: OpsPodDefaults;
  /** confirm: the edit being written (the pane's; a failed write goes back to its editor). */
  edit?: EditState;
  /** confirm: where a prepared local terminal opens, below ("column") or to the right ("row"). */
  split?: "row" | "column";
  /** columns: the pane's columns, loaded before it opens. */
  columns?: ColumnChoices;
  /** field: a field's values over time (⇧H in the YAML); ⏎ takes the pane there. */
  field?: FieldHistory;
  /** config: the file as it was when the editor opened (config.yaml or keybindings.yaml). */
  configFile?: ConfigFile;
  /** logs: what the tail follows: the row's pods (key), every pod the pane shows (⌥L) or the marked rows' pods. */
  scope?: LogsScope;
  /** Focus restored when the overlay closes. */
  restore: FocusContext;
}

/**
 * An open decode: the levels down to the field shown (Go resolves each
 * level's line to a path on the first request; later ones send the paths),
 * whether it's the decoded diff, and the diff's version (unset = the newest).
 */
export interface DecodeState {
  levels: DecodeLevel[];
  diff: boolean;
  which: "yaml" | "norm";
  version?: number;
  /** Bumped when the request changes, so the view reloads (a toggled step, another level). */
  gen: number;
  /** The shown level's chain was changed by hand (a click on a step): ↺ goes back to the detected one. */
  toggled?: boolean;
}

/** An open edit (see bridge/edit.go): Go holds the original, the UI the text being edited. */
export interface EditState {
  session: string;
  /** The row edited (the overlay may be a confirm meanwhile). */
  key: string;
  /** "kind name" for the header. */
  title: string;
  /** As opened, for "discard changes?". */
  opened: string;
  /** Where the editor's cursor starts: on the line the object's YAML had it. */
  at?: Place;
  yaml: string;
  /** Set once the dry run passed: the editor shows its diff instead (focus editpreview). */
  preview?: EditPreview;
  error?: string;
  /** Esc with changes asks once; the second Esc discards. */
  discarding?: boolean;
  /** Values decoded for editing (⌘E), each in the one before (the first in yaml); the last is shown. */
  levels?: EditLevel[];
}

/**
 * A decoded value being edited (⌘E in the editor): Esc encodes it back into
 * the text above (the object's, or the level before's) with the chain it was
 * decoded with. Go keeps nothing: the encode sends the texts again.
 */
export interface EditLevel {
  /** The field and how it was decoded (Go's answer). */
  field: EditDecoded;
  /** The text above as it was when this level opened (the field's encoded value is read from it). */
  above: string;
  /** As decoded, for "changed". */
  opened: string;
  text: string;
}

export type FilterField = "grep" | "labels" | "cel";

export interface UIState {
  tabs: Tab[];
  activeTab: number;
  panes: Record<string, PaneState>;
  focus: FocusContext;
  /** Which filter bar field "filter" focus means (default grep). */
  filterField?: FilterField;
  overlay?: Overlay;
  /** The cheat sheet's find (⌘F in the help overlay): the query and the current match. */
  helpFind?: { query: string; index: number };
  nextId: number;
  /** Default spec for new panes (current kube context). */
  defaults: PaneSpec;
  /** Tab ids, most recently used first (see touchTab). */
  mru: string[];
  /** ⌃⇥ switcher while ⌃ is held: index into mru of the highlighted tab. */
  switcher?: { index: number; restore: FocusContext };
  /** Detail view (Monaco) wraps long lines; session-wide, toggled with w. */
  wrap: boolean;
  /** Object YAML (viewer and editor) shows each line's field manager in the gutter; session-wide, toggled with b (⌘B in the editor). */
  blame?: boolean;
}

/** Namespace a context starts in: the kubeconfig's, else "" (all). "" (or "@1/") = the current context. */
export function contextNamespace(list: ContextList | undefined, context: string): string {
  if (!list) return "";
  // "@1/" is that kubeconfig's current context, as "" is kubewing's own
  return list.namespaces?.[splitCluster(context).context ? context : list.current] ?? "";
}

export const initialSpec = (context = "", namespace = ""): PaneSpec => ({
  context,
  resource: "pods",
  namespace,
  labelSelector: "",
  grep: "",
  filter: "",
});

export function initialState(context = "", namespace = ""): UIState {
  const spec = initialSpec(context, namespace);
  return {
    tabs: [{ id: "t1", layout: leaf("v1"), focused: "v1" }],
    activeTab: 0,
    panes: { v1: { id: "v1", spec, selected: 0 } },
    focus: "table",
    nextId: 2,
    defaults: spec,
    mru: ["t1"],
    wrap: true,
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
 * only say "back to the pane" (table); a terminal pane makes it terminal, or
 * ended once its shell is gone (keys are the app's again, e.g. ⌃D closes).
 * Applied after every state update, like touchTab.
 */
export function paneFocus(s: UIState): UIState {
  // the find field belongs to the focused terminal/log pane's open bar; otherwise it's the pane's own context
  if (s.focus === "termfind" && focusedPane(s)?.term?.find?.open) return s;
  if (s.focus === "logsfind" && focusedPane(s)?.logs?.find?.open) return s;
  const paneContexts: FocusContext[] = ["table", "terminal", "ended", "termfind", "logs", "logsfind", "detail", "edit", "editpreview"];
  if (!paneContexts.includes(s.focus)) return s;
  const p = focusedPane(s);
  const want: FocusContext = p?.logs ? "logs" : p?.term ? (p.term.exited === undefined ? "terminal" : "ended") : p?.object ? objectFocus(p.object) : "table";
  return s.focus === want ? s : { ...s, focus: want };
}

/** An object view's focus context: its viewer, or the editor (or the editor's dry-run diff). */
const objectFocus = (o: ObjectView): FocusContext => (o.edit ? (o.edit.preview ? "editpreview" : "edit") : "detail");

/** The edit in a pane's object view has changes not written yet (in the object's text, or a decoded level's). */
export const unsaved = (p: PaneState | undefined) => {
  const e = p?.object?.edit;
  return !!e && (e.yaml !== e.opened || !!e.levels?.some((l) => l.text !== l.opened));
};

/** The editor's shown text: the last decoded level's, else the object's. */
export const editText = (e: EditState) => e.levels?.at(-1)?.text ?? e.yaml;

/** ⌘E: a decoded level on top of the editor. */
export function pushEditLevel(s: UIState, paneId: string, session: string, l: EditLevel): UIState {
  return setEdit(s, paneId, (e) => (e.session !== session ? e : { ...e, levels: [...(e.levels ?? []), l], error: undefined, discarding: false }));
}

/** The text of the editor's shown level as typed (the last level's, else the object's). */
export function setEditText(s: UIState, paneId: string, text: string): UIState {
  return setEdit(s, paneId, (e) => {
    const ls = e.levels;
    if (!ls?.length) return { ...e, yaml: text, discarding: false };
    return { ...e, levels: [...ls.slice(0, -1), { ...ls.at(-1)!, text }], discarding: false };
  });
}

/**
 * Esc in a decoded level: it's gone, its text encoded into the level above
 * (above: that text as encoded by Go). Only if the levels are still the
 * ones encoded (n deep, the last one's text as sent); else unchanged.
 */
export function popEditLevel(s: UIState, paneId: string, session: string, n: number, sent: string, above: string): UIState {
  return setEdit(s, paneId, (e) => {
    const ls = e.levels;
    if (e.session !== session || ls?.length !== n || ls.at(-1)!.text !== sent) return e;
    const rest = ls.slice(0, -1);
    if (!rest.length) return { ...e, levels: undefined, yaml: above, error: undefined };
    return { ...e, levels: [...rest.slice(0, -1), { ...rest.at(-1)!, text: above }], error: undefined };
  });
}


/** What the history keeps of an object view: not its editor (the session is gone once it's left). */
const kept = (o: ObjectView | undefined): ObjectView | undefined => {
  if (!o?.edit) return o;
  const { edit: _, viaEdit: __, ...rest } = o;
  return rest;
};

/**
 * ⏎ (y, d, e …) in the table: the row's object over it, in place. A
 * navigation like a jump: the table (with the row) goes on the back
 * history, so Esc or ⌘← return to it, scrolled as it was.
 */
export function openObject(s: UIState, paneId: string, object: ObjectView): UIState {
  const p = s.panes[paneId];
  if (!p) return s;
  s = pushHistory(s, paneId, object.key);
  s = updatePane(s, paneId, (q) => ({ ...q, object: { ...object, split: false, from: undefined, follow: undefined, followOff: undefined } }));
  return { ...focusPane(s, paneId), focus: "table", overlay: undefined };
}

/**
 * ⇧⏎ in the table (or in an object view, its decoded value): the object in
 * a pane of its own, to the right. It holds the table's server pane (see
 * PaneState.leased), so it stays when the table closes or shows another
 * source; `from` is the table, whose selection it can follow.
 */
export function openObjectSplit(s: UIState, object: ObjectView, from = activeTab(s).focused): UIState {
  const src = s.panes[from];
  if (!src?.serverId) return s;
  // from an object view in a split: the table that one came from
  const table = src.object?.split ? src.object.from : from;
  const id = `v${s.nextId}`;
  const next = withTab(focusPane(s, from), (t) => ({ ...t, layout: split(t.layout, from, "row", id), focused: id }));
  const pane: PaneState = {
    id,
    spec: { ...src.spec },
    selected: 0,
    serverId: src.serverId,
    leased: true,
    context: src.context,
    kind: src.kind,
    type: src.type,
    ambiguous: src.ambiguous,
    object: { ...kept(object)!, split: true, from: table, follow: undefined, followOff: undefined },
  };
  return { ...next, nextId: s.nextId + 1, panes: { ...s.panes, [id]: pane }, focus: "table", overlay: undefined };
}

/** The focused pane's object view (a split just opened) gets an editor. */
export function withEdit(s: UIState, edit: EditState): UIState {
  return setObject(s, activeTab(s).focused, (o) => ({ ...o, edit }));
}

/** Changes the object view of a pane (no view: unchanged). */
export function setObject(s: UIState, paneId: string, f: (o: ObjectView) => ObjectView): UIState {
  const o = s.panes[paneId]?.object;
  return o ? updatePane(s, paneId, (p) => ({ ...p, object: f(o) })) : s;
}

/** Why a split object view can't follow its table (none: it can). */
export function followBlocked(s: UIState, p: PaneState): string | undefined {
  const from = p.object?.from ? s.panes[p.object.from] : undefined;
  if (!p.object?.split || !p.object.from) return "opened from no table";
  if (!from) return "the table it came from was closed";
  if (from.serverId !== p.serverId) return "the table it came from shows another source now";
  return undefined;
}

/** The follow checkbox: on (if the table is still there, on the same source) or off. */
export function setFollow(s: UIState, paneId: string, on: boolean): UIState {
  const p = s.panes[paneId];
  if (!p?.object) return s;
  if (on && followBlocked(s, p)) return s;
  return setObject(s, paneId, (o) => ({ ...o, follow: on || undefined, followOff: undefined }));
}

/** Following: the table's selected row is shown instead (its diff from the newest, nothing decoded). */
export function followTo(s: UIState, paneId: string, key: string): UIState {
  const o = s.panes[paneId]?.object;
  if (!o?.follow || o.edit || o.key === key) return s;
  return setObject(s, paneId, (x) => ({ ...x, key, version: undefined, decode: undefined, title: undefined }));
}

/**
 * Following stops once its table is gone or shows another source (the rows
 * there aren't this source's); the header says why. Applied after every
 * state update, like paneFocus.
 */
export function checkFollow(s: UIState): UIState {
  for (const p of Object.values(s.panes)) {
    if (!p.object?.follow) continue;
    const why = followBlocked(s, p);
    if (why) s = setObject(s, p.id, (o) => ({ ...o, follow: undefined, followOff: why }));
  }
  return s;
}

/** Opens a terminal pane for a session below the focused pane (⌘D direction; "row": to its right) and focuses it. */
export function openTerminal(s: UIState, term: Term, from = activeTab(s).focused, dir: "row" | "column" = "column"): UIState {
  const src = s.panes[from] ?? focusedPane(s);
  const id = `v${s.nextId}`;
  const next = withTab(s, (t) => ({ ...t, layout: split(t.layout, from, dir, id), focused: id }));
  return {
    ...next,
    nextId: s.nextId + 1,
    panes: { ...s.panes, [id]: { id, spec: { ...src.spec }, selected: 0, term, context: term.context } },
    focus: "terminal",
    overlay: undefined,
  };
}

/**
 * Opens terminals in a new tab of their own, tiled (one debug container per
 * marked pod); the first is focused. from: the pane whose spec they keep.
 */
export function openTerminalTab(s: UIState, terms: Term[], name: string, from = activeTab(s).focused): UIState {
  const src = s.panes[from] ?? focusedPane(s);
  const ids = terms.map((_, i) => `v${s.nextId + i}`);
  const panes = { ...s.panes };
  terms.forEach((term, i) => (panes[ids[i]!] = { id: ids[i]!, spec: { ...src.spec }, selected: 0, term, context: term.context }));
  const tab: Tab = { id: `t${s.nextId}`, layout: grid(ids), focused: ids[0]!, name };
  return { ...s, tabs: [...s.tabs, tab], activeTab: s.tabs.length, nextId: s.nextId + terms.length, panes, focus: "terminal", overlay: undefined };
}

/** Opens a log pane below the focused pane and focuses it. */
export function openLogs(s: UIState, logs: Logs, from = activeTab(s).focused): UIState {
  const src = s.panes[from] ?? focusedPane(s);
  const id = `v${s.nextId}`;
  const next = withTab(s, (t) => ({ ...t, layout: split(t.layout, from, "column", id), focused: id }));
  return {
    ...next,
    nextId: s.nextId + 1,
    panes: { ...s.panes, [id]: { id, spec: { ...src.spec }, selected: 0, logs, context: logs.context } },
    focus: "logs",
    overlay: undefined,
  };
}

/**
 * Opens log panes at once (a pane per pod): stacked below the pane they come
 * from, or in a new tab of their own (tab: its name), stacked; the first is
 * focused.
 */
export function openLogPanes(s: UIState, logs: Logs[], tab?: string, from = activeTab(s).focused): UIState {
  if (!logs.length) return s;
  const src = s.panes[from] ?? focusedPane(s);
  const ids = logs.map((_, i) => `v${s.nextId + i}`);
  const panes = { ...s.panes };
  logs.forEach((l, i) => (panes[ids[i]!] = { id: ids[i]!, spec: { ...src.spec }, selected: 0, logs: l, context: l.context }));
  const stacked = ids.length === 1 ? leaf(ids[0]!) : ({ type: "split", dir: "column", children: ids.map(leaf) } as Layout);
  const next = tab
    ? { ...s, tabs: [...s.tabs, { id: `t${s.nextId}`, layout: stacked, focused: ids[0]!, name: tab }], activeTab: s.tabs.length }
    : withTab(s, (t) => ({ ...t, layout: stackBelow(t.layout, from, ids), focused: ids[0]! }));
  return { ...next, nextId: s.nextId + logs.length, panes, focus: "logs", overlay: undefined };
}

/** Updates the focused log pane's filter. */
export function setLogFilter(s: UIState, paneId: string, filter: string): UIState {
  return updatePane(s, paneId, (p) => (p.logs ? { ...p, logs: { ...p.logs, filter } } : p));
}

/** Toggles a log pane's timestamps. */
export function toggleLogTimestamps(s: UIState, paneId: string): UIState {
  return updatePane(s, paneId, (p) => (p.logs ? { ...p, logs: { ...p.logs, timestamps: !p.logs.timestamps } } : p));
}

/** ⌘F in a log pane: opens its find bar and focuses the field. */
export function openLogFind(s: UIState): UIState {
  const p = focusedPane(s);
  if (!p?.logs) return s;
  const find = { ...(p.logs.find ?? noFind), open: true };
  return { ...updatePane(s, p.id, (q) => ({ ...q, logs: { ...q.logs!, find } })), focus: "logsfind" };
}

export function closeLogFind(s: UIState): UIState {
  const p = focusedPane(s);
  if (!p?.logs?.find?.open) return s.focus === "logsfind" ? { ...s, focus: "logs" } : s;
  const next = updatePane(s, p.id, (q) => ({ ...q, logs: { ...q.logs!, find: { ...q.logs!.find!, open: false } } }));
  return { ...next, focus: "logs" };
}

export function updateLogFind(s: UIState, paneId: string, f: (x: TermFind) => TermFind): UIState {
  return updatePane(s, paneId, (q) => (q.logs ? { ...q, logs: { ...q.logs, find: f(q.logs.find ?? noFind) } } : q));
}

/** ⌘F in the cheat sheet: opens the find box (keeping any earlier query) and focuses it. */
export function openHelpFind(s: UIState): UIState {
  if (s.overlay?.kind !== "help") return s;
  return { ...s, focus: "helpfind", helpFind: { query: s.helpFind?.query ?? "", index: 0 } };
}

/** Esc in the find box: back to the sheet, the find cleared. */
export function closeHelpFind(s: UIState): UIState {
  if (s.focus !== "helpfind") return s;
  return { ...s, focus: "help", helpFind: undefined };
}

/** ⌘G / ⌘⇧G / ⏎ / ⇧⏎: step the current match; the component wraps it against the live count. */
export function stepHelpFind(s: UIState, delta: number): UIState {
  if (!s.helpFind) return s;
  return { ...s, helpFind: { ...s.helpFind, index: s.helpFind.index + delta } };
}

/** Typing in the find box: a new query starts the matches afresh. */
export function setHelpFindQuery(s: UIState, query: string): UIState {
  if (!s.helpFind) return s;
  return { ...s, helpFind: { query, index: 0 } };
}

/** Edit sessions (Go holds the original) no pane's editor references any more: closed, left, or the pane gone. */
export function orphanedEdits(prev: UIState, next: UIState): string[] {
  if (prev.panes === next.panes) return [];
  const sess = (p: PaneState) => p.object?.edit?.session;
  const live = new Set(Object.values(next.panes).map(sess));
  // a confirm of the edit being written still needs it
  if (next.overlay?.edit) live.add(next.overlay.edit.session);
  return Object.values(prev.panes).flatMap((p) => {
    const id = sess(p);
    return id && !live.has(id) ? [id] : [];
  });
}

/** Exec and log sessions no pane references any more (closed panes/tabs). */
export function orphanedSessions(prev: UIState, next: UIState): string[] {
  if (prev.panes === next.panes) return [];
  const sess = (p: PaneState) => p.term?.session ?? p.logs?.session;
  const live = new Set(Object.values(next.panes).map(sess));
  return Object.values(prev.panes).flatMap((p) => {
    const id = sess(p);
    return id && !live.has(id) ? [id] : [];
  });
}

/**
 * An exec session ended. A shell the user ended (⌃D, `exit`, any status) takes
 * its pane with it. One that failed on its own keeps the pane, so the reason
 * stays on screen: an error message (it never ran), or a non-zero exit before
 * the first keystroke (e.g. 127, or a pod printing why and exiting).
 * Go sends an exit status, else an error message.
 */
export function sessionEnded(s: UIState, session: string, exit: string): UIState {
  const pane = Object.values(s.panes).find((p) => p.term?.session === session);
  if (!pane) return logsEnded(s, session, exit);
  if (exit === "0" || (/^\d+$/.test(exit) && pane.term!.typed)) return closePane(s, pane.id);
  return updatePane(s, pane.id, (p) => ({ ...p, term: { ...p.term!, exited: exit } }));
}

/**
 * A log session ended (every follower stopped, or the watch closed). The
 * pane stays so its backlog and the reason remain readable; the header shows
 * it ended. A log tail never "succeeds", so there is no 0-exit auto-close.
 */
export function logsEnded(s: UIState, session: string, exit: string): UIState {
  const pane = Object.values(s.panes).find((p) => p.logs?.session === session);
  if (!pane) return s;
  // a log tail has no meaningful exit code; "0" (every follower stopped) reads as "ended"
  const text = exit === "0" || exit === "" ? "ended" : exit;
  return updatePane(s, pane.id, (p) => ({ ...p, logs: { ...p.logs!, exited: text } }));
}

/** The user typed into a terminal pane (see Term.typed). */
export function termTyped(s: UIState, paneId: string): UIState {
  const t = s.panes[paneId]?.term;
  return !t || t.typed ? s : updatePane(s, paneId, (p) => ({ ...p, term: { ...t, typed: true } }));
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
  tabs[s.activeTab] = unmaximized(f(activeTab(s)));
  return { ...s, tabs };
}

/** A maximized pane stays so only while it is focused and the tab's panes are unchanged (no split, no close). */
function unmaximized(t: Tab): Tab {
  if (!t.maximized || (t.focused === t.maximized && paneIds(t.layout).length > 1)) return t;
  const { maximized: _, ...rest } = t;
  return rest;
}

/**
 * ⌘⇧⏎ (iTerm): the focused pane fills the tab, or back to the splits. The
 * other panes stay open behind it (their watches and shells keep running);
 * moving focus, splitting or closing a pane shows them again. A tab with
 * one pane has nothing to maximize.
 */
export function toggleMaximize(s: UIState): UIState {
  const t = activeTab(s);
  if (t.maximized) return withTab(s, ({ maximized: _, ...rest }) => rest);
  if (paneIds(t.layout).length < 2) return s;
  return withTab(s, (x) => ({ ...x, maximized: x.focused }));
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

/** ⇧⏎ in the jump menu: a new pane below the focused one (⌘D direction; "row": to its right), showing spec. */
export function splitWith(s: UIState, spec: PaneSpec, dir: "row" | "column" = "column"): UIState {
  const id = `v${s.nextId}`;
  const next = withTab(s, (t) => ({ ...t, layout: split(t.layout, t.focused, dir, id), focused: id }));
  return { ...next, nextId: s.nextId + 1, panes: { ...s.panes, [id]: { id, spec, selected: 0 } }, focus: "table" };
}

export function closePane(s: UIState, id = activeTab(s).focused): UIState {
  const index = s.tabs.findIndex((t) => paneIds(t.layout).includes(id));
  if (index < 0) return s;
  const t = s.tabs[index]!;
  const ids = paneIds(t.layout);
  const layout = remove(t.layout, id);
  const panes = { ...s.panes };
  delete panes[id];
  // its name field goes with it
  if (s.overlay?.kind === "renamePane" && s.overlay.pane === id) s = closeOverlay(s);
  if (!layout) return closeTab({ ...s, panes }, index, false);
  const idx = ids.indexOf(id);
  const rest = paneIds(layout);
  // a split object view hands the focus back to the table it came from, if it's still there
  const from = s.panes[id]?.object?.from;
  const focused = t.focused !== id ? t.focused : from && rest.includes(from) ? from : rest[Math.max(0, idx - 1)] ?? rest[0]!;
  const tabs = [...s.tabs];
  const { maximized: _, ...kept } = t;
  tabs[index] = { ...kept, layout, focused };
  // a pane closing on its own (an ended session) must not pull focus out of the pane in use
  const moved = index === s.activeTab && t.focused === id;
  return moved ? { ...s, tabs, panes, focus: "table", overlay: undefined } : { ...s, tabs, panes };
}

/**
 * A cluster names a kubeconfig context: "dev" (kubewing's own kubeconfig, ""
 * its current context) or "@1/dev" (a terminal's own kubeconfig that launched
 * kubewing again; see internal/source/kubeconfig.go).
 */
export function splitCluster(cluster: string): { kubeconfig: string; context: string } {
  const m = /^(@\d+)\/(.*)$/s.exec(cluster);
  return m ? { kubeconfig: m[1]!, context: m[2]! } : { kubeconfig: "", context: cluster };
}

/** A cluster as shown: the context's name, "(current)" for the current one. */
export const clusterLabel = (cluster: string) => splitCluster(cluster).context || "(current)";

/** Table panes on a cluster whose open failed (their error replaces the table): a reconnect retries them. */
export function failedPanes(s: UIState, cluster: string): string[] {
  return Object.values(s.panes)
    .filter((p) => p.error && !p.serverId && !p.opening && !p.term && !p.logs && p.spec.context === cluster)
    .map((p) => p.id);
}

/** Where ⌘⇧O opens a cluster: in the focused pane, a new pane next to it, a new tab. */
export type ClusterTarget = "here" | "pane" | "tab";

/**
 * ⌘⇧O ⏎: a pane on another cluster, in the namespace it starts in, listing
 * nothing yet: ⌘O (opened over it) picks what. A ⌘O context switch, as it
 * keeps nothing of the pane's view.
 */
export function clusterSpec(cluster: string, namespace = ""): PaneSpec {
  return { ...initialSpec(cluster, namespace), resource: "" };
}

/** A pane listing nothing (opened by ⌘⇧O, before ⌘O picked a resource). */
export const emptySpec = (spec: PaneSpec) => !spec.resource;

/** The resource of a listing: everything in a namespace, listed once (not kubectl's `all` category). */
export const allResources = "all";
export const isAll = (resource: string) => resource.trim().toLowerCase() === allResources;

/**
 * The start without a current context (no kubeconfig, or none set as
 * current): a pane listing nothing with ⌘⇧O open over it, not client-go's
 * fallback (localhost:8080, connection refused). New tabs, and the pane left
 * when the last tab closes, start empty too.
 */
export function pickClusterState(): UIState {
  const s = initialState();
  const spec = clusterSpec("");
  return openOverlay({ ...s, panes: { v1: { ...s.panes.v1!, spec } }, defaults: spec }, { kind: "clusters", pane: "v1" });
}

/**
 * The address of a local cluster that refused the connection (a stopped
 * kind or minikube, the port gone), from Go's dial error: "127.0.0.1:61894",
 * "[::1]:6443", "localhost:8080". undefined for anything else.
 */
export function localRefused(error: string | undefined): string | undefined {
  const m = error?.match(/dial tcp ((?:127(?:\.\d{1,3}){3}|\[::1\]|localhost):\d+): connect: connection refused/);
  return m?.[1];
}

/** A later launch from a terminal: a tab on its kubeconfig's context, in that context's namespace. */
export function launchTab(s: UIState, cluster: string, namespace = "", spec = initialSpec(cluster, namespace)): UIState {
  const next = newTab(s);
  const id = next.tabs[next.activeTab]!.focused;
  return { ...next, panes: { ...next.panes, [id]: { id, spec, selected: 0 } } };
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
  // its name field goes with it
  if (s.overlay?.kind === "renameTab" && s.overlay.tabId === s.tabs[index]?.id) s = closeOverlay(s);
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
  if (index !== s.activeTab) {
    // another tab went away (a session ended there): stay where the user is
    return { ...s, tabs, panes, activeTab: s.activeTab > index ? s.activeTab - 1 : s.activeTab };
  }
  return { ...s, tabs, panes, activeTab: Math.min(index, tabs.length - 1), focus: "table", overlay: undefined };
}

/**
 * ⌘W, or a tab's × button: closes the tab, unless it holds splits or an edit not
 * written (work a stray click shouldn't lose); then a dialog asks first.
 */
export function requestCloseTab(s: UIState, tabId = activeTab(s).id): UIState {
  const index = s.tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return s;
  const tab = s.tabs[index]!;
  const ids = paneIds(tab.layout);
  if (ids.length < 2 && !ids.some((id) => unsaved(s.panes[id]))) return closeTab(s, index);
  return openOverlay(closeOverlay(s), { kind: "closeTab", pane: tab.focused, tabId });
}

export function cycleTab(s: UIState, delta: number): UIState {
  const n = s.tabs.length;
  return { ...s, activeTab: (s.activeTab + delta + n) % n, overlay: undefined, focus: "table" };
}

/** Dragging a tab in the tab bar: it goes to index `to`, the others close up; the same tab stays active. */
export function moveTab(s: UIState, tabId: string, to: number): UIState {
  const from = s.tabs.findIndex((t) => t.id === tabId);
  const i = Math.max(0, Math.min(to, s.tabs.length - 1));
  if (from < 0 || from === i) return s;
  const active = activeTab(s).id;
  const tabs = [...s.tabs];
  tabs.splice(i, 0, ...tabs.splice(from, 1));
  return { ...s, tabs, activeTab: tabs.findIndex((t) => t.id === active) };
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

/** Where a dragged pane goes: a side of another pane, an edge of a tab (pane unset), or a new tab. */
export type MoveTarget = { tab: string; pane?: string; side: Side } | { newTab: true };

/**
 * Drag and drop by a pane's grip (ghostty): the pane moves, as it is (its
 * watch, its shell, its history), next to another pane or to the edge of a
 * tab, also another one, or into a new tab of its own. The tab it ends up in
 * is shown with the pane focused there. A tab left empty closes; its other
 * panes regain the space. A drop onto itself, or one that leaves the tab
 * arranged as it was, is no move (the drag offers no such target).
 */
export function movePane(s: UIState, id: string, to: MoveTarget): UIState {
  const fromIndex = s.tabs.findIndex((t) => paneIds(t.layout).includes(id));
  if (fromIndex < 0) return s;
  const from = s.tabs[fromIndex]!;
  if ("newTab" in to) {
    if (paneIds(from.layout).length < 2) return s; // already alone in its tab
  } else {
    const t = s.tabs.find((x) => x.id === to.tab);
    if (!t || to.pane === id || (to.pane && !paneIds(t.layout).includes(to.pane))) return s;
    if (t.id === from.id && !to.pane && paneIds(t.layout).length < 2) return s;
  }
  const rest = remove(from.layout, id);
  let tabs = [...s.tabs];
  if (rest) {
    const ids = paneIds(from.layout);
    const left = paneIds(rest);
    const focused = from.focused === id ? left[Math.max(0, ids.indexOf(id) - 1)] ?? left[0]! : from.focused;
    const { maximized: _, ...kept } = from;
    tabs[fromIndex] = { ...kept, layout: rest, focused };
  } else tabs = tabs.filter((_, i) => i !== fromIndex);
  let activeTab: number;
  let nextId = s.nextId;
  if ("newTab" in to) {
    tabs.push({ id: `t${nextId++}`, layout: leaf(id), focused: id });
    activeTab = tabs.length - 1;
  } else {
    activeTab = tabs.findIndex((t) => t.id === to.tab);
    const t = tabs[activeTab]!;
    const base = t.id === from.id ? rest! : t.layout;
    const layout = to.pane ? insert(base, to.pane, to.side, id) : insertEdge(base, to.side, id);
    // e.g. the bottom of two stacked panes dropped below the top one again: no target
    if (t.id === from.id && sameShape(layout, from.layout)) return s;
    const { maximized: _, ...kept } = t;
    tabs[activeTab] = { ...kept, layout, focused: id };
  }
  return { ...s, tabs, activeTab, nextId, focus: "table", overlay: undefined, switcher: undefined };
}

/** ⌘⇧I, a double-click on the tab: the tab's name field, in place. */
export function renameTab(s: UIState, tabId = activeTab(s).id): UIState {
  if (!s.tabs.some((t) => t.id === tabId)) return s;
  return openOverlay(closeOverlay(s), { kind: "renameTab", pane: activeTab(s).focused, tabId });
}

/** ⌘I, a double-click on the pane's header: the pane's name field there; the pane gets the focus. */
export function renamePane(s: UIState, paneId = activeTab(s).focused): UIState {
  if (!s.panes[paneId]) return s;
  return openOverlay(closeOverlay(focusPane(s, paneId)), { kind: "renamePane", pane: paneId });
}

/** A typed name, trimmed; an empty one removes it (back to the title from the pane's source). */
function named<T extends { name?: string }>(x: T, name: string): T {
  const { name: _, ...rest } = x;
  const n = name.trim();
  return n ? { ...x, name: n } : (rest as T);
}

export function nameTab(s: UIState, tabId: string, name: string): UIState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === tabId ? named(t, name) : t)) };
}

export function namePane(s: UIState, paneId: string, name: string): UIState {
  return updatePane(s, paneId, (p) => named(p, name));
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

/** Pixels a divider moves per ⌘⌃arrow (held, the key repeats). */
const RESIZE_STEP_PX = 40;

/**
 * ⌘⌃arrows: moves a divider of the focused pane in that direction (see
 * layout.resize). `box` is the tab's size in pixels. Not while maximized:
 * the others are hidden, so nothing would show.
 */
export function resizePane(s: UIState, dir: Direction, box: { width: number; height: number }): UIState {
  const t = activeTab(s);
  if (t.maximized) return s;
  const extent = dir === "left" || dir === "right" ? box.width : box.height;
  if (extent <= 0) return s;
  const layout = resize(t.layout, t.focused, dir, RESIZE_STEP_PX / extent, MIN_PANE_PX / extent);
  return layout === t.layout ? s : withTab(s, () => ({ ...t, layout }));
}

export function focusPane(s: UIState, id: string): UIState {
  if (!paneIds(activeTab(s).layout).includes(id)) return s;
  return withTab(s, (t) => ({ ...t, focused: id }));
}

/** Focus contexts that are a pane itself, not a field, dialog or menu in front of it. */
const hoverable: FocusContext[] = ["table", "terminal", "ended", "logs", "detail", "edit", "editpreview"];

/**
 * Focus follows mouse (config focusFollowsMouse): the pointer moved over a
 * pane. It takes the focus only from another pane: not from a filter or find
 * field, a dialog, a menu or the tab switcher, which keep it until left; and
 * not from a maximized pane (the others are hidden behind it anyway).
 */
export function hoverFocus(s: UIState, id: string): UIState {
  const t = activeTab(s);
  if (t.focused === id || t.maximized || s.overlay || s.switcher || !hoverable.includes(s.focus)) return s;
  return focusPane(s, id);
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

/** The focus context an overlay holds while it is open. */
const overlayFocus: Record<Overlay["kind"], FocusContext> = {
  open: "dialog",
  clusters: "dialog",
  confirm: "confirm",
  closeTab: "confirm",
  closePane: "confirm",
  portforward: "dialog",
  debug: "dialog",
  meta: "dialog",
  opspod: "dialog",
  forwards: "forwards",
  menu: "menu",
  // a menu too: the same keys (j/k, ⏎, Esc)
  container: "menu",
  help: "help",
  // the menu's keys, plus ⇧⏎ (split)
  jump: "menu",
  history: "menu",
  // no bindings of its own: ⌘C is the native copy of the selection there
  error: "dialog",
  columns: "dialog",
  // a menu too: j/k, ⏎, Esc
  cells: "menu",
  field: "menu",
  // a text field: every plain key is typing
  renameTab: "dialog",
  renamePane: "dialog",
  logs: "dialog",
  // the release notes: Esc and its buttons, handled in the dialog
  update: "dialog",
  // a YAML editor in a dialog: its keys are Monaco's, Esc and ⌘S the dialog's
  config: "dialog",
};

/** ⌘⏎ menu entries that open another menu in its place, at its anchor: the menu stays until they do. */
export const replacesMenu = (cmd: CommandId) => cmd === "object.jump" || cmd === "object.copyCell";

export function openOverlay(s: UIState, o: Omit<Overlay, "restore">): UIState {
  return { ...s, overlay: { ...o, restore: s.focus }, focus: overlayFocus[o.kind] };
}

/** A pane's editor (its object view's); the focus follows what it shows: the editor, or the dry-run diff. */
export function setEdit(s: UIState, paneId: string, f: (e: EditState) => EditState): UIState {
  const o = s.panes[paneId]?.object;
  if (!o?.edit) return s;
  return setObject(s, paneId, (x) => ({ ...x, edit: f(o.edit!) }));
}

/**
 * [ / ]: the object diff (or the decoded diff) one version older or newer,
 * within the kept ones (`range` is the loaded diff's). Steps from the
 * version asked for, not the loaded one, so quick presses add up while a
 * load is under way. Stepping to the newest follows it again (version
 * unset), so new changes show as they come in.
 */
export function stepVersion(s: UIState, paneId: string, dir: -1 | 1, range: { to: number; first: number; last: number } | undefined): UIState {
  const o = s.panes[paneId]?.object;
  if (!o || !range || o.edit) return s;
  if (o.decode) {
    const d = o.decode;
    if (!d.diff) return s;
    const from = d.version ?? range.to;
    const to = Math.max(range.first, Math.min(from + dir, range.last));
    if (to === from) return s;
    return setObject(s, paneId, (x) => ({ ...x, decode: { ...d, version: to >= range.last ? undefined : to, gen: d.gen + 1 } }));
  }
  if (!o.diff || o.view === "describe") return s;
  const from = o.version ?? range.to;
  const to = Math.max(range.first, Math.min(from + dir, range.last));
  if (to === from) return s;
  return setObject(s, paneId, (x) => ({ ...x, version: to >= range.last ? undefined : to }));
}

/** ⏎ in an object view: the field on its line (0-based) decoded; in a decoded YAML, a level deeper. */
export function decodeDeeper(s: UIState, paneId: string, line: number): UIState {
  const o = s.panes[paneId]?.object;
  if (!o || o.edit) return s;
  const d = o.decode;
  if (!d) {
    if (o.view === "describe") return s;
    // the line is one of the YAML view (the object) or of the diff's right side (normalized)
    const decode: DecodeState = { levels: [{ line, steps: null }], diff: !!o.diff, which: o.diff ? "norm" : "yaml", version: o.diff ? o.version : undefined, gen: 0 };
    return setObject(s, paneId, (x) => ({ ...x, decode }));
  }
  if (d.diff) return s; // a diff has two values under the cursor: deeper from the YAML view
  return setObject(s, paneId, (x) => ({ ...x, decode: { ...d, levels: [...d.levels, { line, steps: null }], gen: d.gen + 1, toggled: false } }));
}

/** The levels as Go resolved them (paths and chains), kept without reloading: [ / ] and toggles go by them. */
export function decodeResolved(s: UIState, paneId: string, levels: DecodeLevel[]): UIState {
  const d = s.panes[paneId]?.object?.decode;
  if (!d || levels.length !== d.levels.length || d.levels.every((l) => l.path)) return s;
  return setObject(s, paneId, (x) => ({ ...x, decode: { ...d, levels } }));
}

/** ↺: the shown level's chain detected again. */
export function decodeAuto(s: UIState, paneId: string): UIState {
  const d = s.panes[paneId]?.object?.decode;
  if (!d) return s;
  const last = d.levels[d.levels.length - 1]!;
  return setObject(s, paneId, (x) => ({ ...x, decode: { ...d, levels: [...d.levels.slice(0, -1), { ...last, steps: null, raw: false }], gen: d.gen + 1, toggled: false } }));
}

/**
 * Esc in a decoded value: a level up; from the first, back to the object.
 * Unchanged (the same state) when nothing is decoded.
 */
export function decodeUp(s: UIState, paneId: string): UIState {
  const d = s.panes[paneId]?.object?.decode;
  if (!d) return s;
  // a level never loaded (refused: nothing to decode on its line) goes without reloading the one shown
  const pending = d.levels[d.levels.length - 1]!.path === undefined;
  if (d.levels.length > 1)
    return setObject(s, paneId, (x) => ({ ...x, decode: { ...d, levels: d.levels.slice(0, -1), gen: pending ? d.gen : d.gen + 1, toggled: pending ? d.toggled : false } }));
  return setObject(s, paneId, ({ decode: _, ...x }) => x);
}

/**
 * A click on a step of the shown level's chain: the chain up to it, without
 * it (base64 → brotli → yaml, click brotli: base64 only). The rendering
 * (yaml, jwt, pem …) as the last "step" toggles raw: the bytes as text.
 * `levels` are the loaded ones (paths resolved); a chain cut short is kept
 * as it is until the level is left.
 */
export function decodeToggle(s: UIState, paneId: string, levels: DecodeLevel[], step: number | "render"): UIState {
  const d = s.panes[paneId]?.object?.decode;
  if (!d || !levels.length) return s;
  const last = levels[levels.length - 1]!;
  const steps = last.steps ?? [];
  const next: DecodeLevel = step === "render" ? { ...last, raw: !last.raw } : { ...last, steps: steps.slice(0, step), raw: false };
  return setObject(s, paneId, (x) => ({ ...x, decode: { ...d, levels: [...levels.slice(0, -1), next], gen: d.gen + 1, toggled: true } }));
}

/**
 * Esc at the top of an object view (nothing decoded, no editor): over a
 * table, back to it (the history step it was); in a split, the pane closes.
 * `repeat`: a held Esc (key repeat) climbs decode levels but stops here, so
 * holding it can't close anything.
 */
export function leaveObject(s: UIState, paneId: string, repeat = false): UIState {
  const p = s.panes[paneId];
  if (!p?.object || repeat) return s;
  if (p.object.split) return closePane(s, paneId);
  return back(s, paneId);
}

/** The view before an object opened over the table: the table, with the row and scroll it had. */
function back(s: UIState, paneId: string): UIState {
  const p = s.panes[paneId]!;
  const entry = p.back?.at(-1);
  // opened from the table, as the history says: the table comes back as it was (the same server pane)
  if (entry && !entry.object && sameSource(entry.spec, p.spec)) {
    const forward = [...(p.forward ?? []), { spec: p.spec, key: p.object!.key, object: kept(p.object) }].slice(-historyLimit);
    const { object: _, ...rest } = p;
    return updatePane(s, paneId, () => ({ ...rest, back: orNone(p.back!.slice(0, -1)), forward }));
  }
  // nothing to go back to (an old history): the table under it
  const { object: _, ...rest } = p;
  return updatePane(s, paneId, () => rest);
}

/**
 * A menu's highlight moved by delta (±1), skipping entries that can't be
 * picked and wrapping around (↑ on the first goes to the last, ↓ on the last
 * to the first). undefined: nothing to pick.
 */
export function wrapIndex<T>(items: T[], index: number, delta: number, ok: (item: T) => boolean): number | undefined {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((index + delta * k) % n) + n) % n;
    if (ok(items[i]!)) return i;
  }
  return undefined;
}

export function closeOverlay(s: UIState): UIState {
  if (!s.overlay) return s;
  // the cheat sheet's find is a sub-state of the sheet: leaving the sheet clears it
  return { ...s, overlay: undefined, focus: s.overlay.restore, helpFind: undefined };
}

/** YAML pipeline for a pane (see internal/pipeline). JSON is valid YAML. */
export function pipelineYAML(spec: PaneSpec): string {
  const source: Record<string, string> = { resource: spec.resource };
  if (spec.context) source.cluster = spec.context;
  if (spec.namespace) source.namespace = spec.namespace;
  if (spec.labelSelector) source.labelSelector = spec.labelSelector;
  if (spec.fieldSelector) source.fieldSelector = spec.fieldSelector;
  const p: Record<string, unknown> = { source };
  const stages = [
    ...(spec.hideHealthy ? [{ hideHealthy: true }] : []),
    ...(spec.filter ? [{ filter: spec.filter }] : []),
    ...(spec.grep ? [{ grep: spec.grep }] : []),
    ...(spec.sort ? [{ sort: [spec.sort] }] : []),
  ];
  if (stages.length) p.stages = stages;
  return JSON.stringify(p);
}

/** Server panes referenced by `prev` but no longer by `next` (UI pane closed or source replaced). */
export function orphanedServerPanes(prev: UIState, next: UIState): string[] {
  if (prev.panes === next.panes) return [];
  const live = new Set(Object.values(next.panes).map((p) => p.serverId));
  // a split object view shares its table's: once each
  return [...new Set(Object.values(prev.panes).flatMap((p) => (p.serverId && !live.has(p.serverId) ? [p.serverId] : [])))];
}

export const sameSource = (a: PaneSpec, b: PaneSpec) =>
  a.context === b.context && a.resource === b.resource && a.namespace === b.namespace && a.labelSelector === b.labelSelector && (a.fieldSelector ?? "") === (b.fieldSelector ?? "");

/**
 * The spec a jump opens: the target in the pane's context. Everything the
 * target doesn't set is cleared (a jump replaces the filters), so the pane
 * shows exactly why it holds what it holds.
 */
export function jumpSpec(from: PaneSpec, t: JumpTarget): PaneSpec {
  const spec: PaneSpec = {
    context: from.context,
    resource: t.resource,
    namespace: t.namespace ?? "",
    labelSelector: t.labelSelector ?? "",
    grep: t.grep ?? "",
    filter: t.filter ?? "",
  };
  if (t.fieldSelector) spec.fieldSelector = t.fieldSelector;
  // "pods in shop" carries the pane's own filter along: the jump's only if it was before
  const jumpFilter = t.filter === from.filter ? from.jumpFilter : t.filter;
  if (t.filter && jumpFilter) spec.jumpFilter = jumpFilter;
  if (t.hideHealthy) spec.hideHealthy = true;
  return spec;
}

const orNone = <T>(l: T[]) => (l.length ? l : undefined);

/**
 * ⌘J ⏎: the pane shows the target instead; its current view (and the row
 * the jump started from) goes on the back history, and the forward history
 * is dropped, as a browser does on a new navigation. Bounded. The caller
 * applies the new spec (applySpec).
 */
export function pushHistory(s: UIState, paneId: string, key: string | undefined): UIState {
  return updatePane(s, paneId, (p) => ({
    ...p,
    back: [...(p.back ?? []), { spec: p.spec, key: p.object?.key ?? key, object: kept(p.object) }].slice(-historyLimit),
    forward: undefined,
    reselect: undefined,
  }));
}

/**
 * What the ⌘O dialog starts from: the pane's spec without what a jump put
 * there to pick its target (the field selector, which the dialog can't
 * show, and the CEL filter as long as it's the jump's: o.metadata.name ==
 * "shop" would hide everything else on another resource). A filter typed
 * since stays.
 */
export function openSpec(spec: PaneSpec): PaneSpec {
  const { fieldSelector: _, jumpFilter, ...rest } = spec;
  return jumpFilter !== undefined && rest.filter === jumpFilter ? { ...rest, filter: "" } : rest;
}

/**
 * ⌘O ⏎: a new source (context, resource, namespace, selectors) is a
 * navigation like a jump (pushHistory); the same source again isn't. Filter
 * edits never go through here: they're state of the view, as form fields
 * are on a web page, and come back with it.
 */
export function openHistory(s: UIState, paneId: string, spec: PaneSpec, key: string | undefined): UIState {
  const p = s.panes[paneId];
  return p && !sameSource(p.spec, spec) ? pushHistory(s, paneId, key) : s;
}

/**
 * ⌘← (back) / ⌘→ (forward): the view at the top of that history, while
 * the current view (with its selected row, key) moves onto the other one.
 * Returns the entry to restore (the caller applies its spec and the row is
 * reselected once shown), or no entry when there's nowhere to go.
 * steps > 1 (a pick from the history list): the views passed over move to
 * the other history too, in order, as a browser does.
 */
export function moveHistory(s: UIState, paneId: string, dir: "back" | "forward", key: string | undefined, steps = 1): { state: UIState; entry?: HistoryEntry } {
  const p = s.panes[paneId];
  const from = dir === "back" ? p?.back : p?.forward;
  const entry = steps >= 1 ? from?.at(-steps) : undefined;
  if (!p || !entry) return { state: s };
  const rest = from!.slice(0, -steps);
  const passed = from!.slice(-steps + 1 || from!.length).reverse();
  const other = [...((dir === "back" ? p.forward : p.back) ?? []), { spec: p.spec, key: p.object?.key ?? key, object: kept(p.object) }, ...passed].slice(-historyLimit);
  const back = dir === "back" ? rest : other;
  const forward = dir === "back" ? other : rest;
  // the entry's object view comes back with it (decoded levels and all); its row is selected under it, for Esc
  return {
    state: updatePane(s, paneId, (x) => ({ ...x, back: orNone(back), forward: orNone(forward), reselect: entry.key, object: entry.object })),
    entry,
  };
}

/** The row to reselect after moving through the history is shown at index (or gone, -1): select it and stop looking. */
export function reselected(s: UIState, paneId: string, key: string, index: number): UIState {
  if (s.panes[paneId]?.reselect !== key) return s; // a stale answer (moved on meanwhile)
  return updatePane(s, paneId, (p) => ({ ...p, reselect: undefined, selected: index >= 0 ? index : p.selected }));
}
