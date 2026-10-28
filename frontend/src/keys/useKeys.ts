import { useEffect } from "react";
import { dispatch, openLaunch } from "../commands";
import { useConfig } from "../store/config";
import { bridge, paneData, useUI } from "../store/store";
import * as S from "../store/state";
import { chord, commandIds, editorModal, editorMoves, fieldReserved, keyContexts, resolveIn, suppressedDefaults, type CommandId } from "./keymap";

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
      // so does a field's open suggestion list (the filter bar's label and CEL fields) before the field
      if (c === "Escape" && e.target instanceof Element && e.target.getAttribute("aria-expanded") === "true") return;
      // typing in Monaco's find field is text, not the detail view's d/j/k/y … keys
      if (e.target instanceof Element && e.target.closest(".find-widget") && fieldReserved(c)) return;
      // so is its right-click menu: ⏎ runs the entry, Esc closes the menu (not the detail view)
      // (it may live in a shadow root: the path, not the target, has it)
      if (fieldReserved(c) && e.composedPath().some((n) => n instanceof Element && n.classList.contains("monaco-menu"))) return;
      // ⌘F in the detail view opens Monaco's find (suppressedDefaults would block it)
      if (c === "Meta+F" && e.target instanceof Element && e.target.closest(".monaco-editor")) return;
      const s = useUI.getState();
      // the YAML editor in a dialog (the node shell's) is modal too, without keys of its own: Esc is the dialog's
      const dialogEditor = s.focus === "dialog" && e.target instanceof Element && e.target.closest("[data-editor]");
      const cmd = dialogEditor ? undefined : resolveIn(c, keyContexts(s.focus, traveling(s)), useConfig.getState().bindings);
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();
        // a held key (Esc climbing decoded levels) stops short of leaving or closing an object view
        dispatch(cmd, { repeat: e.repeat });
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
    // a ⌘ chord an editor leaves to Monaco but Monaco doesn't use (⌘T, ⌘1 …) would fire as the native
    // menu's key equivalent: menu commands wait until the editor is closed or left
    const editing = () => editorModal(useUI.getState().focus) || !!document.activeElement?.closest("[data-editor]");
    const offMenu = bridge().onCommand((c) => {
      if (known.has(c) && (!editing() || editorMoves(c as CommandId))) dispatch(c as CommandId);
    });
    const offLaunch = bridge().onLaunch(openLaunch);
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
      offMenu();
      offLaunch();
    };
  }, []);
}
