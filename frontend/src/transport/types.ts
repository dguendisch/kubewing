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
  /** The source records history (shared by its splits): the detail diff steps through versions. */
  recording?: boolean;
  /** Time-travel: the pane shows its objects as of this moment (RFC 3339); unset = live. */
  at?: string;
  /** Live events since, applied behind the past. */
  behind?: number;
  /** The pane shows metric columns but there is no usage (no metrics-server, forbidden …). */
  metricsError?: string;
  /** The pane shows a node's requests/limits columns and their pods are still being listed. */
  allocLoading?: boolean;
  /** Why the requests/limits columns are empty (the pods can't be listed). */
  allocError?: string;
}

/** Mirrors view.Timeline: what a pane can travel over (RFC 3339 times). */
export interface Timeline {
  horizon: string;
  newest: string;
  /** The moment shown; unset = live. */
  at?: string;
  /** Moments a row of the pane changed, ascending. */
  changes: string[];
  /** The source's recorded history: estimated bytes (all its objects) and its budget. */
  bytes: number;
  budget: number;
}

/** Mirrors view.FieldHistory: one field's values over a row's history. */
export interface FieldHistory {
  path: string;
  changes: { at: string; value?: string; absent?: boolean; version: number }[];
}

/** A field path step (mirrors fieldpath.Step); opaque to the UI, sent back as received. */
export interface PathStep {
  key?: string;
  by?: string;
  val?: string;
  index?: number;
  list?: boolean;
}

/** Mirrors view.DecodeLevel: a field and the chain applied to its value (see view/decode.go). */
export interface DecodeLevel {
  /** The field's line (0-based) while path is unset: of the object's YAML, or of the level above's decoded text. */
  line: number;
  path?: PathStep[];
  doc?: number;
  /** null: detect the chain (the answer has it). */
  steps: string[] | null;
  raw?: boolean;
}

/** Mirrors view.DecodeRequest. */
export interface DecodeRequest {
  key: string;
  which: "yaml" | "norm";
  to: number;
  diff?: boolean;
  levels: DecodeLevel[];
}

/** Mirrors view.Decoded: the last level's field decoded (and, for a diff, the version before's). */
export interface Decoded {
  levels: DecodeLevel[];
  path: string;
  steps: string[] | null;
  kind: "jwt" | "pem" | "json" | "yaml" | "text" | "binary" | "";
  text: string;
  language: "yaml" | "json" | "plaintext" | "";
  size: number;
  absent?: boolean;
  /** Why the field can't be decoded (a map, plain text …): an answer, not an error; the rest is unset. */
  refused?: string;
  prev?: { text: string; absent?: boolean; error?: string };
  diff?: DiffInfo;
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
  /** Resource type column settings are kept by (pods, deployments.apps). */
  type: string;
  /** resource exists in several groups: only type tells them apart. */
  ambiguous?: boolean;
  /** The type's default sort, applied because the pipeline had none (events: "LAST SEEN"). */
  sort?: string;
}

/** Mirrors pipeline.Column: a custom column (path or expr), else a server column by name. */
export interface ColumnSpec {
  name: string;
  path?: string;
  expr?: string;
  type?: ColumnType;
}

/** Mirrors config.TypeView: a resource type's columns (none = server defaults) and dragged widths. */
export interface TypeView {
  columns?: ColumnSpec[];
  widths?: Record<string, number>;
  /** Where the usage (metrics) and requests/limits (allocation) columns were when turned off; unset = the default place. */
  metrics?: MetricsPlace;
  allocation?: MetricsPlace;
}

/** Mirrors config.MetricsPlace: after this column ("" = first), the shown ones in their order. */
export interface MetricsPlace {
  after: string;
  order?: string[];
}

/** Mirrors view.ColumnOption: a column the column dialog offers. */
export interface ColumnOption {
  name: string;
  type?: ColumnType;
  /** > 0: a server column kubectl shows only with -o wide. */
  priority?: number;
  shown: boolean;
  path?: string;
  expr?: string;
  /** A configured server column this resource doesn't have. */
  missing?: boolean;
  /** A metric column: "usage" (kubectl top, polled while shown) or "alloc" (a node's requests/limits, summed from its pods). */
  metric?: "usage" | "alloc";
}

/** Mirrors view.ColumnChoices. */
export interface ColumnChoices {
  options: ColumnOption[];
  /** The columns shown without settings, in order. */
  defaults: string[];
}

export interface Detail {
  key: string;
  name: string;
  yaml: string;
  prevNorm?: string;
  curNorm: string;
  deleted?: boolean;
  /** Which versions prevNorm → curNorm are; absent if the history has nothing for the row. */
  diff?: DiffInfo;
}

/** Mirrors view.DiffInfo: a detail diff's place in the object's history. Versions count up per object. */
export interface DiffInfo {
  /** 0: `to` is the oldest kept version, nothing before it. */
  from: number;
  to: number;
  fromAt?: string;
  toAt: string;
  /** The versions kept (at most a few dozen). */
  first: number;
  last: number;
  /** What changed from → to, as `path: old → new`. */
  changes?: string[];
}

export interface ContextList {
  contexts: string[];
  current: string;
  /** Namespace a context sets in the kubeconfig, for those that set one. */
  namespaces?: Record<string, string>;
  /** The files of a terminal's own kubeconfig (its contexts are clusters like "@1/dev"); unset: kubewing's own. */
  kubeconfig?: string[];
}

/** Mirrors app.Launch: a later launch from a terminal, opened as a tab on its kubeconfig. */
export interface Launch {
  cluster: string;
  namespace?: string;
  /** The terminal's kubeconfig couldn't be read. */
  error?: string;
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

/** Mirrors bridge.LabelCounts: label keys or a key's values, with how many of objects have them. */
export interface LabelCounts {
  items: { value: string; count: number }[];
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
  config: { theme?: string; diff: { ignore: { path: string; kinds?: string[] }[] }; contexts: ContextRule[]; debug?: DebugConfig; opsPod?: OpsPodConfig; terminal?: { scrollback: number }; logs?: { tail: number; maxStreams: number; buffer: number }; launch?: { wait?: boolean } };
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

export type ActionKind = "delete" | "exec" | "debug" | "opspod" | "edit";

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

/** Mirrors bridge.EditSession: an opened editor (Go keeps the original it patches against). */
export interface EditSession {
  session: string;
  yaml: string;
}

/** Mirrors bridge.EditPreview: what an edit changes, as the server's dry run reports it. */
export interface EditPreview {
  patch: string;
  prevNorm: string;
  curNorm: string;
  /** The server would store nothing new (e.g. only status was edited). */
  noChange?: boolean;
}

/** Mirrors relations.Target: where a jump lands, in the pane's context ("" namespace = all). */
export interface JumpTarget {
  resource: string;
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  filter?: string;
  grep?: string;
  hideHealthy?: boolean;
}

/** Mirrors relations.Relation: one jump menu entry. */
export interface Relation {
  id: string;
  section: "field" | "namespace" | "owner" | "owned" | "reference" | "events";
  label: string;
  kind?: string;
  name?: string;
  /** Owners: 1 = direct, 2 = the owner's owner … */
  depth?: number;
  controller?: boolean;
  /** undefined = nowhere to go (see gone). */
  target?: JumpTarget;
  /** Owned objects found; undefined = not counted. */
  count?: number;
  /** Why an owner can't be jumped to (deleted, recreated). */
  gone?: string;
  /** Qualifies an entry that still works (not checked, not counted). */
  note?: string;
  /** How many fields refer to this object (from 2 on). */
  places?: number;
}

/** Mirrors bridge.FieldMark: a reference value in a YAML text (0-based line, 1-based columns, end exclusive). */
export interface FieldMark {
  line: number;
  col: number;
  endCol: number;
  label: string;
}

/** Mirrors bridge.Relations: the jump menu of one row. */
export interface Relations {
  kind: string;
  name: string;
  namespace?: string;
  items: Relation[];
  /** The owned scan can look for any kind owned by this object. */
  scan?: boolean;
  /** The scan spans all namespaces and cluster-scoped types (asks first). */
  scanAll?: boolean;
}

/** Mirrors bridge.OwnedScanResult. */
export interface OwnedScan {
  items: Relation[];
  scanned: number;
  skipped?: number;
  skipReason?: string;
}

/** Mirrors bridge.RowInfo: identity and capabilities of one row (no object content). */
export interface RowInfo {
  key: string;
  kind: string;
  name: string;
  namespace?: string;
  deleted?: boolean;
  hasPrev?: boolean;
  /** With recorded history: how many changes of the row are kept (the diff steps through them). */
  changes?: number;
  pod?: boolean;
  /** The row can produce logs: a pod, or a workload/node/namespace with pods. */
  logs?: boolean;
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
  /** "" = default (with a PV: its claim's). */
  namespace: string;
  hostRoot: boolean;
  /** The shell runs in /host (implies hostRoot). */
  chroot: boolean;
  hostNetwork: boolean;
  /** A persistent volume mounted at mountPath ("" = none; path default /pv). */
  pv?: string;
  mountPath?: string;
  readOnly?: boolean;
  /** The pod as edited in the dialog: created instead of the options' pod. */
  yaml?: string;
}

/** Mirrors bridge.PVInfo. */
export interface PVInfo {
  name: string;
  phase?: string;
  /** The bound claim, namespace/name. */
  claim?: string;
  capacity?: string;
  storageClass?: string;
  accessModes?: string[];
}

/** Mirrors bridge.PVList: from the shared persistentvolumes watch. */
export interface PVList {
  context: string;
  pvs: PVInfo[];
  loading?: boolean;
  error?: string;
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

/** Mirrors logs.Line: one log line of a stream (its id), timestamp split off. */
export interface LogLine {
  stream: string;
  ts?: string;
  text: string;
}

/** Mirrors logs.Stream: one followed container. */
export interface LogStream {
  id: string;
  pod: string;
  namespace: string;
  container: string;
  /** Stable per-pod color index (0…5). */
  color: number;
  state: "following" | "ended" | "limited";
}

/** Mirrors bridge.LogsPayload: a log session's stream set and/or line batch. */
export interface LogsPayload {
  id: string;
  streams?: LogStream[];
  lines?: LogLine[];
  /** Lines dropped since the last event (batch overflow). */
  dropped?: number;
  /** Set on the last event. */
  exit?: string;
}

/** Mirrors bridge.LogsOptions: the log dialog's choices. */
export interface LogsOptions {
  /** Unset = every container. */
  containers?: string[];
  /** Lines back per container; 0 = the configured logs.tail. */
  tail?: number;
  /** A Go duration ("10m"): start that long ago instead of tail lines back. */
  since?: string;
  /** The whole log. */
  all?: boolean;
  follow: boolean;
}

/** Mirrors bridge.LogsTargets: what the dialog offers for a tail. */
export interface LogsTargets {
  title: string;
  containers: string[];
  /** The configured logs.tail. */
  tail: number;
}

/** Mirrors bridge.LogsResult. */
export interface LogsResult {
  session: string;
  context: string;
  /** What is tailed, for the pane header ("api-0", "deploy/etcd", "pods · ns"). */
  title: string;
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
  /**
   * Label keys (key "") or a key's values, most common first, among the pane's source objects that match
   * others (the draft's other requirements): label selector completion, not limited by the applied selector.
   */
  labels(pane: string, key: string, others: string): Promise<LabelCounts>;
  /** The pane's columns for the column dialog: shown ones in order, then the other server columns. */
  columnChoices(pane: string): Promise<ColumnChoices>;
  /** Every resource type's column settings, by type. */
  columnConfigs(): Promise<Record<string, TypeView>>;
  /** Saves a type's shown columns (null = defaults) and applies them to its panes; rejects an invalid column. */
  setTypeColumns(type: string, columns: ColumnSpec[] | null): Promise<void>;
  /** setTypeColumns for the metrics switch, saving where the metric columns were too (null = right after NAME). */
  setTypeMetrics(type: string, group: "usage" | "alloc", columns: ColumnSpec[] | null, place: MetricsPlace | null): Promise<void>;
  /** Saves a type's dragged column widths (null = defaults). */
  setColumnWidths(type: string, widths: Record<string, number> | null): Promise<void>;
  setViewport(pane: string, offset: number, limit: number): Promise<void>;
  resync(pane: string): Promise<void>;
  /** A row's detail; `to` diffs that version against the one before (omitted / 0 = the newest). */
  object(pane: string, key: string, to?: number): Promise<Detail>;
  /** Starts or stops history recording for the pane's source (every split on it). */
  setRecording(pane: string, on: boolean): Promise<void>;
  /** Shows the pane as of `at` (RFC 3339; "" = live); starts recording if needed. */
  setTime(pane: string, at: string): Promise<Timeline>;
  /** To the next (1) or previous (-1) change of the pane's rows. */
  step(pane: string, dir: number): Promise<{ moved: boolean; timeline: Timeline }>;
  timeline(pane: string): Promise<Timeline>;
  /** How the field on a line (0-based) of the row's normalized YAML went (version `to`, 0 = the one shown). */
  /** which: the text the line is of, the YAML view's ("yaml") or the diff's normalized one ("norm"). */
  fieldHistory(pane: string, key: string, to: number, line: number, which: "yaml" | "norm"): Promise<FieldHistory>;
  /** A row's field decoded (⏎ in the YAML): base64, brotli, gzip, then JWT, PEM, JSON/YAML; decoded again on every call. */
  decode(pane: string, req: DecodeRequest): Promise<Decoded>;
  close(pane: string): Promise<void>;
  /** The contexts of a cluster's kubeconfig ("" = kubewing's own; "@1/…" a terminal's). */
  contexts(cluster: string): Promise<ContextList>;
  /** Never connects; empty until a pane opened on the context. Poll while loading. */
  catalog(context: string): Promise<Catalog>;
  /** Safety rule for a context name: a pane's resolved one (OpenResult.context), not its cluster. */
  contextRule(context: string): Promise<SafetyRule>;
  /** Checks a mutation against the safety policy (Go decides); throws if refused. */
  prepare(kind: ActionKind, pane: string, key: string): Promise<Pending>;
  /** Executes a prepared delete. */
  delete(token: string): Promise<void>;
  /** Reads a row's object fresh from the server into a new edit session; refused on read-only contexts. */
  editOpen(pane: string, key: string): Promise<EditSession>;
  /** Checks an edit and dry-runs it on the server; writes nothing. */
  editCheck(session: string, yaml: string): Promise<EditPreview>;
  /** Writes a prepared edit (the same patch editCheck dry-ran). */
  editApply(token: string, session: string, yaml: string): Promise<void>;
  editClose(session: string): Promise<void>;
  /** Identity and capabilities of a row (context menu, port-forward defaults). */
  rowInfo(pane: string, key: string): Promise<RowInfo>;
  /** A row's position in the pane's current order (-1 = not shown). */
  rowIndex(pane: string, key: string): Promise<number>;
  /** The jump menu of a row: namespace, owner chain, known owned kinds (read-only, metadata only). */
  relations(pane: string, key: string): Promise<Relations>;
  /** The reference values in an object's YAML (as shown), to mark and ⌘-click. */
  fieldRefs(pane: string, text: string): Promise<FieldMark[]>;
  /** The jump menu's field section: what the field at line (0-based) of text refers to, looked up. */
  fieldRelations(pane: string, text: string, line: number): Promise<Relation[]>;
  /** Where v goes: the events about the row's object (read-only; refused for an event). */
  eventsTarget(pane: string, key: string): Promise<JumpTarget>;
  /** Every resource type with objects owned by the row (lists all types: explicit only). */
  ownedScan(pane: string, key: string): Promise<OwnedScan>;
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
  /** A context's persistent volumes, from the shared persistentvolumes watch; poll while loading. */
  persistentVolumes(cluster: string): Promise<PVList>;
  /** The pod an ops pod with these options would be, as YAML (creates nothing). */
  opsPodManifest(cluster: string, node: string, opts: OpsPodOptions): Promise<string>;
  /** Runs the start's checks (image, namespace, PV, edited YAML) without creating anything; throws what's wrong. */
  checkOpsPod(cluster: string, node: string, opts: OpsPodOptions): Promise<void>;
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
  /** What a log tail of a row (or the whole pods pane) would follow: its containers. */
  logsTargets(pane: string, key: string, whole: boolean): Promise<LogsTargets>;
  /** Starts a log tail of a row's pods; whole = every pod the (pods) pane shows. */
  logsStart(pane: string, key: string, whole: boolean, opts: LogsOptions): Promise<LogsResult>;
  /** Puts text on the system clipboard. */
  copyText(text: string): Promise<void>;
  config(): Promise<Config>;
  reloadConfig(): Promise<Config>;
  /** Drops the connection to a cluster ("" = current) and restarts its watches; resolves to how many restarted. */
  reconnect(cluster: string): Promise<number>;
  /** Installs the native menu's command menus (macOS app; a no-op headless). */
  setMenu(menus: AppMenu[]): Promise<void>;
  onFrame(cb: (p: FramePayload) => void): () => void;
  onConfig(cb: (c: Config) => void): () => void;
  /** A type's column settings changed (any client): all types' settings. */
  onColumns(cb: (c: Record<string, TypeView>) => void): () => void;
  onSession(cb: (p: SessionPayload) => void): () => void;
  onLogs(cb: (p: LogsPayload) => void): () => void;
  onPortForwards(cb: (l: PortForward[]) => void): () => void;
  /** A native menu item was chosen: its command id. */
  onCommand(cb: (command: string) => void): () => void;
  /** kubewing was launched again from a terminal: open a tab on its kubeconfig. */
  onLaunch(cb: (l: Launch) => void): () => void;
}
