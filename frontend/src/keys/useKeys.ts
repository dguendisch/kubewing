import { useEffect } from "react";
import { dispatch } from "../commands";
import { useConfig } from "../store/config";
import { useUI } from "../store/store";
import { chord, resolve, suppressedDefaults } from "./keymap";

/** Owns all shortcuts: resolves keydown via the keymap and suppresses webview defaults. */
export function useKeys() {
  useEffect(() => {
    const suppressed = new Set(suppressedDefaults);
    const onKey = (e: KeyboardEvent) => {
      const c = chord(e);
      // an open Monaco find widget closes on Esc before the detail view does
      if (c === "Escape" && e.target instanceof Element && e.target.closest(".find-widget.visible")) return;
      // ⌘F in the detail view opens Monaco's find (suppressedDefaults would block it)
      if (c === "Meta+F" && e.target instanceof Element && e.target.closest(".monaco-editor")) return;
      const cmd = resolve(c, useUI.getState().focus, useConfig.getState().bindings);
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
