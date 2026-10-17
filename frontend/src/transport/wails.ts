import { Call, Events } from "@wailsio/runtime";
import type { Transport, FramePayload } from "./types";

const svc = "github.com/dguendisch/kubewing/internal/app.App";
const call = <T>(method: string, ...args: unknown[]) =>
  Call.ByName(`${svc}.${method}`, ...args) as Promise<T>;

export function wailsTransport(): Transport {
  return {
    open: (y) => call("Open", y),
    update: (p, y) => call("Update", p, y),
    setViewport: (p, o, l) => call("SetViewport", p, o, l),
    resync: (p) => call("Resync", p),
    object: (p, k) => call("Object", p, k),
    close: (p) => call("Close", p),
    contexts: () => call("Contexts"),
    catalog: (c) => call("Catalog", c),
    onFrame: (cb) => Events.On("kw:frame", (ev) => cb(ev.data as FramePayload)),
  };
}
