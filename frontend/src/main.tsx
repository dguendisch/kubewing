import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { dispatch } from "./commands";
import type { CommandId } from "./keys/keymap";
import { inspect } from "./inspect";
import { bridge, connect, loadContexts } from "./store/store";
import { logBuffers } from "./logs/buffer";
import { createTransport } from "./transport";
import "./theme.css";

// the macOS app window rounds its corners; panes in them follow (theme.css --kw-window-radius)
if (import.meta.env.VITE_KW_TRANSPORT !== "ws" && /Mac/.test(navigator.platform)) document.documentElement.classList.add("kw-mac");
connect(await createTransport());
await loadContexts();

if (import.meta.env.MODE !== "production") {
  // bridge: e2e tests reset what they saved (one backend serves the whole run); logBuffers: they fill a log pane;
  // dispatch: a native menu click (which a browser can't send)
  (window as unknown as { __kw: { inspect: typeof inspect; bridge: typeof bridge; logBuffers: typeof logBuffers; dispatch: (c: CommandId) => void } }).__kw = {
    inspect,
    bridge,
    logBuffers,
    dispatch: (c) => dispatch(c),
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
