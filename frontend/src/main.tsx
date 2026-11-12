import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Crashed } from "./components/Crashed";
import { dispatch } from "./commands";
import type { CommandId } from "./keys/keymap";
import { inspect } from "./inspect";
import { bridge, connect, loadContexts } from "./store/store";
import { logBuffers } from "./logs/buffer";
import { applyConfig, useConfig } from "./store/config";
import { createTransport } from "./transport";
import { detachPane, listenForPanes, sendPane } from "./store/transfer";
import { listenForDrags } from "./components/PaneDrag";
import { isMainWindow, windowName } from "./store/window";
import "./theme.css";

// the macOS app window rounds its corners; panes in them follow (theme.css --kw-window-radius)
if (import.meta.env.VITE_KW_TRANSPORT !== "ws" && /Mac/.test(navigator.platform)) document.documentElement.classList.add("kw-mac");
connect(await createTransport());
await loadContexts();
// panes handed over from other windows land here; a detached window says it's ready for its pane
listenForPanes();
listenForDrags();
if (!isMainWindow) void bridge().windowReady();

if (import.meta.env.MODE !== "production") {
  // bridge: e2e tests reset what they saved (one backend serves the whole run); logBuffers: they fill a log pane;
  // dispatch: a native menu click (which a browser can't send); config: a setting the shared config.yaml doesn't have
  // (applyConfig: one applied as a reload would, e.g. the font)
  // windowName, sendPane, detachPane: a pane moved to another window, or out of every window, as a drop
  // there would (a browser can't drag outside its window)
  (window as unknown as { __kw: Record<string, unknown> }).__kw = {
    inspect,
    bridge,
    logBuffers,
    dispatch: (c: CommandId) => dispatch(c),
    config: useConfig,
    applyConfig,
    windowName,
    sendPane,
    detachPane,
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Crashed what="kubewing">
      <App />
    </Crashed>
  </StrictMode>,
);
