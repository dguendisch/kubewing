import { useEffect } from "react";
import { dispatch } from "../commands";
import { useUI } from "../store/store";
import { chord, resolve, suppressedDefaults } from "./keymap";

/** Owns all shortcuts: resolves keydown via the keymap and suppresses webview defaults. */
export function useKeys() {
  useEffect(() => {
    const suppressed = new Set(suppressedDefaults);
    const onKey = (e: KeyboardEvent) => {
      const c = chord(e);
      const cmd = resolve(c, useUI.getState().focus);
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();
        dispatch(cmd);
        return;
      }
      if (suppressed.has(c)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
