import { Call, Clipboard, Events } from "@wailsio/runtime";
import type { Config, FramePayload, PortForward, SessionPayload, Transport } from "./types";

const svc = "github.com/dguendisch/kubewing/internal/app.App";
const call = <T>(method: string, ...args: unknown[]) =>
  Call.ByName(`${svc}.${method}`, ...args) as Promise<T>;

export function wailsTransport(): Transport {
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
    debugStart: (t, o, cols, rows) => call("DebugStart", t, o, cols, rows),
    debugImages: () => call("DebugImages"),
    removeDebugImage: (i) => call("RemoveDebugImage", i),
    sessionInput: (id, d) => call("SessionInput", id, d),
    sessionResize: (id, c, r) => call("SessionResize", id, c, r),
    sessionClose: (id) => call("SessionClose", id),
    portForwardStart: (p, k, ports) => call("PortForwardStart", p, k, ports),
    portForwards: () => call("PortForwards"),
    portForwardStop: (id) => call("PortForwardStop", id),
    copyText: async (t) => void (await Clipboard.SetText(t)),
    config: () => call("Config"),
    reloadConfig: () => call("ReloadConfig"),
    setMenu: (m) => call("SetMenu", m),
    onFrame: (cb) => Events.On("kw:frame", (ev) => cb(ev.data as FramePayload)),
    onConfig: (cb) => Events.On("kw:config", (ev) => cb(ev.data as Config)),
    onSession: (cb) => Events.On("kw:session", (ev) => cb(ev.data as SessionPayload)),
    onPortForwards: (cb) => Events.On("kw:portforwards", (ev) => cb(ev.data as PortForward[])),
    onCommand: (cb) => Events.On("kw:command", (ev) => cb(ev.data as string)),
  };
}
