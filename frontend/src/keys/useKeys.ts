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
    // the ⌃⇥ switcher commits when ⌃ is released, and must not outlive a lost window focus
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" && useUI.getState().switcher) dispatch("tab.switcherCommit");
    };
    const onBlur = () => {
      if (useUI.getState().switcher) dispatch("tab.switcherCancel");
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
