import { useEffect } from "react";
import { dispatch } from "../commands";
import { useConfig } from "../store/config";
import { bridge, paneData, useUI } from "../store/store";
import * as S from "../store/state";
import { chord, commandIds, fieldReserved, keyContexts, resolveIn, suppressedDefaults, type CommandId } from "./keymap";

/** The focused pane shows the past (its frames say so). */
function traveling(s: S.UIState): boolean {
  const id = S.focusedPane(s).serverId;
  return !!id && !!paneData.get(id).status?.at;
}

/**
 * Owns all shortcuts: resolves keydown via the keymap and suppresses webview
 * defaults. Native menu items (keys/appMenu.ts) arrive here too, as command ids.
 */
export function useKeys() {
  useEffect(() => {
    const suppressed = new Set(suppressedDefaults);
    const onKey = (e: KeyboardEvent) => {
      const c = chord(e);
      // an open Monaco find widget closes on Esc before the detail view does
      if (c === "Escape" && e.target instanceof Element && e.target.closest(".find-widget.visible")) return;
      // typing in Monaco's find field is text, not the detail view's d/j/k/y … keys
      if (e.target instanceof Element && e.target.closest(".find-widget") && fieldReserved(c)) return;
      // ⌘F in the detail view opens Monaco's find (suppressedDefaults would block it)
      if (c === "Meta+F" && e.target instanceof Element && e.target.closest(".monaco-editor")) return;
      const s = useUI.getState();
      const cmd = resolveIn(c, keyContexts(s.focus, traveling(s)), useConfig.getState().bindings);
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
    const known = new Set<string>(commandIds);
    const offMenu = bridge().onCommand((c) => {
      if (known.has(c)) dispatch(c as CommandId);
    });
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
      offMenu();
    };
  }, []);
}
