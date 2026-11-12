import type { Transport } from "./types";
import { wsTransport } from "./ws";

export * from "./types";

/**
 * Wails IPC inside the app; WebSocket to the headless Go backend when the
 * frontend is served by Vite with VITE_KW_TRANSPORT=ws (E2E, browser dev).
 * The Wails runtime is only loaded in the app (it polls /wails/* otherwise).
 */
export async function createTransport(): Promise<Transport> {
  if (import.meta.env.VITE_KW_TRANSPORT === "ws") {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // a detached window's page is a window of its own (?window=w1): its streams go to its connection
    const name = new URLSearchParams(location.search).get("window");
    return wsTransport(`${proto}://${location.host}/kw-ws${name ? `?window=${encodeURIComponent(name)}` : ""}`);
  }
  const { wailsTransport } = await import("./wails");
  return wailsTransport();
}
