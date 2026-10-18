// Mirrors internal/view/frame.go and internal/bridge/bridge.go.
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
  config: { theme?: string; diff: { ignore: { path: string; kinds?: string[] }[] }; contexts: ContextRule[] };
  keybindings: UserBinding[];
  /** Token name (theme.css without --color-) → color. */
  theme: Record<string, string>;
  errors: string[];
}

/** Mirrors safety.Rule: the effective safety rule for one context. */
export interface SafetyRule {
  context: string;
  label?: string;
  color?: string;
  readOnly?: boolean;
  confirm: string[];
  strict?: boolean;
}

export type ActionKind = "delete" | "exec";

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
  ports?: number[];
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
  fieldKeys(pane: string, path: string): Promise<FieldKeys>;
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
  sessionInput(id: string, data: string): Promise<void>;
  sessionResize(id: string, cols: number, rows: number): Promise<void>;
  sessionClose(id: string): Promise<void>;
  /** Forwards 127.0.0.1 ports to a row's pod ("8080:80", "80" = random local port). */
  portForwardStart(pane: string, key: string, ports: string[]): Promise<PortForward>;
  portForwards(): Promise<PortForward[]>;
  portForwardStop(id: string): Promise<void>;
  config(): Promise<Config>;
  reloadConfig(): Promise<Config>;
  onFrame(cb: (p: FramePayload) => void): () => void;
  onConfig(cb: (c: Config) => void): () => void;
  onSession(cb: (p: SessionPayload) => void): () => void;
  onPortForwards(cb: (l: PortForward[]) => void): () => void;
}
