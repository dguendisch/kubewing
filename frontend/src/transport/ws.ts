import type { Transport, FramePayload } from "./types";

/** WebSocket transport to the headless Go backend (tests, browser dev). */
export function wsTransport(url: string): Transport {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const frameListeners = new Set<(p: FramePayload) => void>();
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
    setViewport: (p, o, l) => call("SetViewport", p, o, l),
    resync: (p) => call("Resync", p),
    object: (p, k) => call("Object", p, k),
    close: (p) => call("Close", p),
    contexts: () => call("Contexts"),
    catalog: (c) => call("Catalog", c),
    onFrame: (cb) => {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
  };
}
