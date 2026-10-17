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

/** The only API the frontend uses to talk to Go. */
export interface Transport {
  open(pipelineYAML: string): Promise<OpenResult>;
  update(pane: string, pipelineYAML: string): Promise<void>;
  setViewport(pane: string, offset: number, limit: number): Promise<void>;
  resync(pane: string): Promise<void>;
  object(pane: string, key: string): Promise<Detail>;
  close(pane: string): Promise<void>;
  contexts(): Promise<ContextList>;
  /** Never connects; empty until a pane opened on the context. Poll while loading. */
  catalog(context: string): Promise<Catalog>;
  onFrame(cb: (p: FramePayload) => void): () => void;
}
