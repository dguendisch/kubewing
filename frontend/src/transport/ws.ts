import type { Config, FramePayload, LogsPayload, PortForward, SessionPayload, Transport, TypeView, UpdateStatus } from "./types";

/** WebSocket transport to the headless Go backend (tests, browser dev). */
export function wsTransport(url: string): Transport {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const frameListeners = new Set<(p: FramePayload) => void>();
  const configListeners = new Set<(c: Config) => void>();
  const columnsListeners = new Set<(c: Record<string, TypeView>) => void>();
  const sessionListeners = new Set<(p: SessionPayload) => void>();
  const logsListeners = new Set<(p: LogsPayload) => void>();
  const forwardListeners = new Set<(l: PortForward[]) => void>();
  const updateListeners = new Set<(s: UpdateStatus) => void>();
  let ws: WebSocket;
  const ready = new Promise<void>((resolve, reject) => {
    ws = new WebSocket(url);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`websocket ${url} failed`));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data as string);
      if (msg.event === "kw:frame") {
        frameListeners.forEach((cb) => cb(msg.data));
        return;
      }
      if (msg.event === "kw:config") {
        configListeners.forEach((cb) => cb(msg.data));
        return;
      }
      if (msg.event === "kw:columns") {
        columnsListeners.forEach((cb) => cb(msg.data));
        return;
      }
      if (msg.event === "kw:session") {
        sessionListeners.forEach((cb) => cb(msg.data));
        return;
      }
      if (msg.event === "kw:logs") {
        logsListeners.forEach((cb) => cb(msg.data));
        return;
      }
      if (msg.event === "kw:portforwards") {
        forwardListeners.forEach((cb) => cb(msg.data));
        return;
      }
      if (msg.event === "kw:update") {
        updateListeners.forEach((cb) => cb(msg.data));
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    };
  });
  const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    await ready;
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, args }));
    });
  };
  return {
    open: (y) => call("Open", y),
    update: (p, y) => call("Update", p, y),
    preview: (p, d) => call("Preview", p, d),
    fieldKeys: (p, path) => call("FieldKeys", p, path),
    labels: (p, key, others) => call("Labels", p, key, others),
    columnChoices: (p) => call("ColumnChoices", p),
    columnConfigs: () => call("ColumnConfigs"),
    setTypeColumns: (t, c) => call("SetTypeColumns", t, c),
    setTypeMetrics: (t, g, c, a) => call("SetTypeMetrics", t, g, c, a),
    setColumnWidths: (t, w) => call("SetColumnWidths", t, w),
    setViewport: (p, o, l) => call("SetViewport", p, o, l),
    resync: (p) => call("Resync", p),
    object: (p, k, to) => (to ? call("ObjectAt", p, k, to) : call("Object", p, k)),
    setRecording: (p, on) => call("SetRecording", p, on),
    setTime: (p, at) => call("SetTime", p, at),
    step: (p, d) => call("Step", p, d),
    timeline: (p) => call("Timeline", p),
    fieldHistory: (p, k, to, line, which) => call("FieldHistory", p, k, to, line, which),
    decode: (p, r) => call("Decode", p, r),
    close: (p) => call("Close", p),
    contexts: (c) => call("Contexts", c),
    catalog: (c) => call("Catalog", c),
    clusters: () => call("Clusters"),
    matchTarget: (t) => call("MatchTarget", t),
    openCluster: (e) => call("OpenCluster", e),
    forgetCluster: (e) => call("ForgetCluster", e),
    otherPlane: (c, ns) => call("OtherPlane", c, ns),
    contextRule: (c) => call("ContextRule", c),
    prepare: (k, p, key) => call("Prepare", k, p, key),
    delete: (t) => call("Delete", t),
    mark: (p, op) => call("Mark", p, op),
    marked: (p) => call("Marked", p),
    prepareMarked: (k, p) => call("PrepareMarked", k, p),
    rowMeta: (p, k) => call("RowMeta", p, k),
    label: (t, c) => call("Label", t, c),
    annotate: (t, c) => call("Annotate", t, c),
    scale: (t, n) => call("Scale", t, n),
    restart: (t) => call("Restart", t),
    editOpen: (p, k) => call("EditOpen", p, k),
    editCheck: (s, y) => call("EditCheck", s, y),
    editApply: (t, s, y) => call("EditApply", t, s, y),
    editClose: (s) => call("EditClose", s),
    editDecode: (r) => call("EditDecode", r),
    editEncode: (r) => call("EditEncode", r),
    rowInfo: (p, k) => call("RowInfo", p, k),
    rowIndex: (p, k) => call("RowIndex", p, k),
    relations: (p, k) => call("Relations", p, k),
    fieldRefs: (p, t) => call("FieldRefs", p, t),
    blame: (p, k, t) => call("Blame", p, k, t),
    fieldRelations: (p, t, l) => call("FieldRelations", p, t, l),
    ownedScan: (p, k) => call("OwnedScan", p, k),
    eventsTarget: (p, k) => call("EventsTarget", p, k),
    describe: (p, k) => call("Describe", p, k),
    execStart: (t, c, cols, rows) => call("ExecStart", t, c, cols, rows),
    debugStart: (t, o, cols, rows) => call("DebugStart", t, o, cols, rows),
    debugImages: () => call("DebugImages"),
    removeDebugImage: (i) => call("RemoveDebugImage", i),
    nodes: (c) => call("Nodes", c),
    opsPodDefaults: () => call("OpsPodDefaults"),
    persistentVolumes: (c) => call("PersistentVolumes", c),
    opsPodManifest: (c, n, o) => call("OpsPodManifest", c, n, o),
    checkOpsPod: (c, n, o) => call("CheckOpsPod", c, n, o),
    opsPodTarget: (p, k) => call("OpsPodTarget", p, k),
    prepareOpsPod: (c, n) => call("PrepareOpsPod", c, n),
    opsPodStart: (t, o, cols, rows) => call("OpsPodStart", t, o, cols, rows),
    prepareTerminal: (c, ns) => call("PrepareTerminal", c, ns),
    terminalStart: (t, cols, rows) => call("TerminalStart", t, cols, rows),
    sessionInput: (id, d) => call("SessionInput", id, d),
    sessionResize: (id, c, r) => call("SessionResize", id, c, r),
    sessionClose: (id) => call("SessionClose", id),
    portForwardStart: (p, k, ports) => call("PortForwardStart", p, k, ports),
    portForwards: () => call("PortForwards"),
    portForwardStop: (id) => call("PortForwardStop", id),
    logsTargets: (p, k, scope) => call("LogsTargets", p, k, scope),
    logsStart: (p, k, scope, o) => call("LogsStart", p, k, scope, o),
    // browser/test build: the page's clipboard
    copyText: (t) => navigator.clipboard.writeText(t),
    config: () => call("Config"),
    reloadConfig: () => call("ReloadConfig"),
    configFile: (f) => call("ConfigFile", f),
    checkConfig: (f, t) => call("CheckConfig", f, t),
    saveConfig: (f, t) => call("SaveConfig", f, t),
    reconnect: (c) => call("Reconnect", c),
    refresh: (p) => call("Refresh", p),
    skipped: (p) => call("Skipped", p),
    setMenu: (m) => call("SetMenu", m),
    updateStatus: () => call("UpdateStatus"),
    checkUpdate: () => call("CheckUpdate"),
    skipUpdate: (v) => call("SkipUpdate", v),
    installUpdate: () => call("InstallUpdate"),
    // browser/test build: the page opens links in a new tab itself (Go has no browser to hand them to)
    openURL: async (u) => void window.open(u, "_blank", "noopener"),
    onFrame: (cb) => {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    onConfig: (cb) => {
      configListeners.add(cb);
      return () => configListeners.delete(cb);
    },
    onColumns: (cb) => {
      columnsListeners.add(cb);
      return () => columnsListeners.delete(cb);
    },
    onSession: (cb) => {
      sessionListeners.add(cb);
      return () => sessionListeners.delete(cb);
    },
    onLogs: (cb) => {
      logsListeners.add(cb);
      return () => logsListeners.delete(cb);
    },
    onPortForwards: (cb) => {
      forwardListeners.add(cb);
      return () => forwardListeners.delete(cb);
    },
    onUpdate: (cb) => {
      updateListeners.add(cb);
      return () => updateListeners.delete(cb);
    },
    // no native menu in the browser, and no second launch to hand over
    onCommand: () => () => {},
    onLaunch: () => () => {},
  };
}
