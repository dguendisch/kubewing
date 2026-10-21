// Mirrors internal/view/frame.go and internal/bridge/bridge.go.
import type { Menu as AppMenu } from "../keys/appMenu";
export type ColumnType = "" | "number" | "bytes" | "age";

export interface ColumnInfo {
  name: string;
  type?: ColumnType;
}

export type Mark = "" | "added" | "deleted";

export interface RowData {
  key: string;
  cells: string[];
  mark?: Mark;
  changed?: number[];
  hidden?: boolean;
}

export interface Status {
  synced: boolean;
  objects: number;
  error?: string;
  /** Objects the CEL filter failed on (a missing field is a plain no-match). */
  filterErrors?: number;
  filterError?: string;
}

export interface Frame {
  seq: number;
  columns?: ColumnInfo[];
  total: number;
  offset: number;
  order: string[];
  rows?: RowData[];
  status?: Status;
}

export interface FramePayload {
  pane: string;
  frame: Frame;
}

export interface OpenResult {
  pane: string;
  /** Resolved context name ("" in the pipeline = current context). */
  context: string;
  kind: string;
  resource: string;
  namespaced: boolean;
}

export interface Detail {
  key: string;
  name: string;
  yaml: string;
  prevNorm?: string;
  curNorm: string;
  deleted?: boolean;
}

export interface ContextList {
  contexts: string[];
  current: string;
  /** Namespace a context sets in the kubeconfig, for those that set one. */
  namespaces?: Record<string, string>;
}

/** Mirrors bridge.Draft: a filter bar edit not applied yet. */
export interface Draft {
  field: "filter" | "labels";
  value: string;
}

/** Mirrors view.Preview: what a draft would show, without applying it. */
export interface Preview {
  matched: number;
  objects: number;
  /** Lower bound: a wider label selector may match objects not loaded yet. */
  atLeast?: boolean;
  errors?: number;
  error?: string;
  /** Can't be applied (parse error, not a bool). */
  invalid?: boolean;
  /** 0-based position of a parse error, or -1. */
  column: number;
}

/** Mirrors bridge.FieldKeys / view.FieldKey: keys at a path across a pane's objects. */
export interface FieldKeys {
  keys: { key: string; type: string; count: number }[];
  objects: number;
}

/** Mirrors source.ResourceType. */
export interface ResourceType {
  name: string;
  group: string;
  version: string;
  kind: string;
  singular?: string;
  shortNames?: string[];
  namespaced: boolean;
}

/** Mirrors catalog.Snapshot: completion data for one context. */
export interface Catalog {
  context: string;
  resources: ResourceType[];
  namespaces: string[];
  loading: boolean;
  partial?: boolean;
  errors?: Record<string, string>;
  gen: number;
}

/** Mirrors config.Binding (keybindings.yaml); validated by keymap.mergeBindings. */
export interface UserBinding {
  key: string;
  command: string;
  when?: string[];
}

/** Mirrors config.ContextRule. */
export interface ContextRule {
  match: string;
  label?: string;
  color?: string;
  readOnly?: boolean;
  confirm?: string[];
  strict?: boolean;
}

/** Mirrors config.Effective: the user's ~/.kubewing/ files, as loaded. */
export interface Config {
  dir: string;
  config: { theme?: string; diff: { ignore: { path: string; kinds?: string[] }[] }; contexts: ContextRule[]; debug?: DebugConfig; opsPod?: OpsPodConfig; terminal?: { scrollback: number } };
  keybindings: UserBinding[];
  /** Token name (theme.css without --color-) → color. */
  theme: Record<string, string>;
  errors: string[];
}

/** Mirrors config.Debug: defaults of the debug dialog. */
export interface DebugConfig {
  image?: string;
  profile?: DebugProfile;
}

/** Mirrors config.OpsPod: defaults of the ops pod dialog. */
export interface OpsPodConfig {
  image?: string;
  namespace?: string;
  chroot?: boolean;
  hostRoot?: boolean;
  hostNetwork?: boolean;
}

/** Mirrors bridge.OpsPodDefaults: the dialog's initial values (last used, else config.yaml, else defaults). */
export interface OpsPodDefaults {
  image: string;
  namespace: string;
  chroot: boolean;
  hostRoot: boolean;
  hostNetwork: boolean;
  /** The settings are the last pod's (history.yaml). */
  remembered?: boolean;
}

/** kubectl debug --profile values (config.DebugProfiles). */
export const debugProfiles = ["general", "baseline", "restricted", "netadmin", "sysadmin"] as const;
export type DebugProfile = (typeof debugProfiles)[number];

/** Mirrors safety.Rule: the effective safety rule for one context. */
export interface SafetyRule {
  context: string;
  label?: string;
  color?: string;
  readOnly?: boolean;
  confirm: string[];
  strict?: boolean;
}

export type ActionKind = "delete" | "exec" | "debug" | "opspod";

/** Mirrors safety.Pending: a prepared mutation awaiting (confirmation and) execution. */
export interface Pending {
  token: string;
  summary: string;
  action: { kind: ActionKind; context: string; resource: string; namespace?: string; name: string; uid?: string };
  rule: SafetyRule;
  needsConfirm: boolean;
  /** Strict mode: the text the user must type to confirm. */
  typeToConfirm?: string;
}

/** Mirrors bridge.RowInfo: identity and capabilities of one row (no object content). */
export interface RowInfo {
  key: string;
  kind: string;
  name: string;
  namespace?: string;
  deleted?: boolean;
  hasPrev?: boolean;
  pod?: boolean;
  containers?: string[];
  /** Every container exec can enter, for the picker. */
  containerInfo?: ContainerInfo[];
  ports?: number[];
  /** The declared container ports in spec order (port-forward completion). */
  portInfo?: PortInfo[];
}

/** Mirrors bridge.ContainerInfo. */
export interface ContainerInfo {
  name: string;
  /** sidecar: an init container with restartPolicy Always; ephemeral: kubectl debug. */
  kind: "container" | "init" | "sidecar" | "ephemeral";
  /** From the pod status; undefined = not reported. */
  state?: "running" | "waiting" | "terminated";
  reason?: string;
  /** The one exec picks without a choice. */
  default?: boolean;
}

/** Mirrors bridge.PortInfo. */
export interface PortInfo {
  port: number;
  name?: string;
  protocol?: string;
  container: string;
}

/** Mirrors bridge.DescribeResult: one describe run plus, from the previous look, a normalized pair to diff. */
export interface DescribeResult {
  text: string;
  prevNorm?: string;
  curNorm?: string;
  /** When the previous look was taken (RFC 3339). */
  prevAt?: string;
}

/** Mirrors bridge.ExecResult. */
export interface ExecResult {
  session: string;
  container: string;
  pod: string;
  context: string;
  containers: string[];
}

/** Mirrors bridge.DebugOptions. */
export interface DebugOptions {
  image: string;
  /** "" = the pod's default container, "-" = none. */
  target: string;
  /** "" = general. */
  profile: string;
}

/** Mirrors bridge.DebugResult. */
export interface DebugResult {
  session: string;
  /** The new ephemeral container. */
  container: string;
  target?: string;
  image: string;
  pod: string;
  context: string;
}

/** Mirrors bridge.NodeInfo: one node for the ops pod dialog's completion. */
export interface NodeInfo {
  name: string;
  /** The Ready condition (True, False, Unknown). */
  ready?: string;
  unschedulable?: boolean;
  pool?: string;
  zone?: string;
}

/** Mirrors bridge.NodeList: from the shared nodes watch (an open nodes pane's data). */
export interface NodeList {
  context: string;
  nodes: NodeInfo[];
  /** The watch hasn't listed yet: ask again. */
  loading?: boolean;
  error?: string;
}

/** Mirrors bridge.OpsPodOptions. */
export interface OpsPodOptions {
  image: string;
  /** "" = default. */
  namespace: string;
  hostRoot: boolean;
  /** The shell runs in /host (implies hostRoot). */
  chroot: boolean;
  hostNetwork: boolean;
}

/** Mirrors bridge.OpsPodResult. */
export interface OpsPodResult {
  session: string;
  pod: string;
  namespace: string;
  node: string;
  image: string;
  context: string;
  settings?: string;
}

/** Mirrors bridge.SessionPayload: output (base64) or, last, the exit. */
export interface SessionPayload {
  id: string;
  data?: string;
  /** "0", an exit code, or an error message. */
  exit?: string;
}

/** Mirrors bridge.PortForwardInfo. */
export interface PortForward {
  id: string;
  context: string;
  namespace: string;
  pod: string;
  ports: { local: number; remote: number }[];
  /** Set once the forward ended on its own (pod gone …). */
  error?: string;
}

/** The only API the frontend uses to talk to Go. */
export interface Transport {
  open(pipelineYAML: string): Promise<OpenResult>;
  update(pane: string, pipelineYAML: string): Promise<void>;
  /** Evaluates a draft filter/label selector against the pane's objects; changes nothing. */
  preview(pane: string, draft: Draft): Promise<Preview>;
  /** Keys at a dot path ("" = top level) across the pane's objects, for CEL completion. */
  /** Keys at a path: one step per key, as in the object ([] = top level). */
  fieldKeys(pane: string, path: string[]): Promise<FieldKeys>;
  setViewport(pane: string, offset: number, limit: number): Promise<void>;
  resync(pane: string): Promise<void>;
  object(pane: string, key: string): Promise<Detail>;
  close(pane: string): Promise<void>;
  contexts(): Promise<ContextList>;
  /** Never connects; empty until a pane opened on the context. Poll while loading. */
  catalog(context: string): Promise<Catalog>;
  /** Safety rule for a pane's cluster ("" = current context). */
  contextRule(cluster: string): Promise<SafetyRule>;
  /** Checks a mutation against the safety policy (Go decides); throws if refused. */
  prepare(kind: ActionKind, pane: string, key: string): Promise<Pending>;
  /** Executes a prepared delete. */
  delete(token: string): Promise<void>;
  /** Identity and capabilities of a row (context menu, port-forward defaults). */
  rowInfo(pane: string, key: string): Promise<RowInfo>;
  /** kubectl describe output for a row (read-only; no token); diffed against the previous look. */
  describe(pane: string, key: string): Promise<DescribeResult>;
  /** Starts a prepared exec; container "" = the pod's default. */
  execStart(token: string, container: string, cols: number, rows: number): Promise<ExecResult>;
  /** Starts a prepared debug: a new ephemeral container, attached once it runs. */
  debugStart(token: string, opts: DebugOptions, cols: number, rows: number): Promise<DebugResult>;
  /** Images of recently started debug containers, newest first (history.yaml). */
  debugImages(): Promise<string[]>;
  /** Forgets one; returns what's left. */
  removeDebugImage(image: string): Promise<string[]>;
  /** The ops pod dialog's initial values. */
  opsPodDefaults(): Promise<OpsPodDefaults>;
  /** A context's nodes ("" = current), from the shared nodes watch; poll while loading. */
  nodes(cluster: string): Promise<NodeList>;
  /** The node a row stands for (a node, a pod's node), to prefill the ops pod dialog. */
  opsPodTarget(pane: string, key: string): Promise<{ node?: string }>;
  /** Checks an ops pod on a node against the safety policy; throws if refused (unknown node, read-only). */
  prepareOpsPod(cluster: string, node: string): Promise<Pending>;
  /** Starts a prepared ops pod: created, shell once it runs, deleted when the session ends. */
  opsPodStart(token: string, opts: OpsPodOptions, cols: number, rows: number): Promise<OpsPodResult>;
  sessionInput(id: string, data: string): Promise<void>;
  sessionResize(id: string, cols: number, rows: number): Promise<void>;
  sessionClose(id: string): Promise<void>;
  /** Forwards 127.0.0.1 ports to a row's pod ("8080:80", "80" = random local port). */
  portForwardStart(pane: string, key: string, ports: string[]): Promise<PortForward>;
  portForwards(): Promise<PortForward[]>;
  portForwardStop(id: string): Promise<void>;
  /** Puts text on the system clipboard. */
  copyText(text: string): Promise<void>;
  config(): Promise<Config>;
  reloadConfig(): Promise<Config>;
  /** Installs the native menu's command menus (macOS app; a no-op headless). */
  setMenu(menus: AppMenu[]): Promise<void>;
  onFrame(cb: (p: FramePayload) => void): () => void;
  onConfig(cb: (c: Config) => void): () => void;
  onSession(cb: (p: SessionPayload) => void): () => void;
  onPortForwards(cb: (l: PortForward[]) => void): () => void;
  /** A native menu item was chosen: its command id. */
  onCommand(cb: (command: string) => void): () => void;
}
