import type { Config, FramePayload, PortForward, SessionPayload, Transport } from "./types";

/** WebSocket transport to the headless Go backend (tests, browser dev). */
export function wsTransport(url: string): Transport {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const frameListeners = new Set<(p: FramePayload) => void>();
  const configListeners = new Set<(c: Config) => void>();
  const sessionListeners = new Set<(p: SessionPayload) => void>();
  const forwardListeners = new Set<(l: PortForward[]) => void>();
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
      if (msg.event === "kw:session") {
        sessionListeners.forEach((cb) => cb(msg.data));
        return;
      }
      if (msg.event === "kw:portforwards") {
        forwardListeners.forEach((cb) => cb(msg.data));
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
    setViewport: (p, o, l) => call("SetViewport", p, o, l),
    resync: (p) => call("Resync", p),
    object: (p, k) => call("Object", p, k),
    close: (p) => call("Close", p),
    contexts: () => call("Contexts"),
    catalog: (c) => call("Catalog", c),
    contextRule: (c) => call("ContextRule", c),
    prepare: (k, p, key) => call("Prepare", k, p, key),
    delete: (t) => call("Delete", t),
    rowInfo: (p, k) => call("RowInfo", p, k),
    describe: (p, k) => call("Describe", p, k),
    execStart: (t, c, cols, rows) => call("ExecStart", t, c, cols, rows),
    sessionInput: (id, d) => call("SessionInput", id, d),
    sessionResize: (id, c, r) => call("SessionResize", id, c, r),
    sessionClose: (id) => call("SessionClose", id),
    portForwardStart: (p, k, ports) => call("PortForwardStart", p, k, ports),
    portForwards: () => call("PortForwards"),
    portForwardStop: (id) => call("PortForwardStop", id),
    config: () => call("Config"),
    reloadConfig: () => call("ReloadConfig"),
    onFrame: (cb) => {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    onConfig: (cb) => {
      configListeners.add(cb);
      return () => configListeners.delete(cb);
    },
    onSession: (cb) => {
      sessionListeners.add(cb);
      return () => sessionListeners.delete(cb);
    },
    onPortForwards: (cb) => {
      forwardListeners.add(cb);
      return () => forwardListeners.delete(cb);
    },
  };
}
