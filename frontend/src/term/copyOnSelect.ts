import type { Terminal as XTerm } from "@xterm/xterm";
import { bridge } from "../store/store";
import { useConfig } from "../store/config";

/** config.yaml terminal.copyOnSelect, read live: a reloaded config applies to open panes at once. */
const enabled = () => !!useConfig.getState().config?.config.terminal?.copyOnSelect;

/**
 * Copy on select (terminal.copyOnSelect): a mouse selection in the xterm goes to the clipboard
 * when the button is released. That covers a drag, a double-click word and a triple-click line.
 * It doesn't copy on xterm's onSelectionChange: that fires at every step of a drag, and also when
 * find (⌘F) selects a match, which must not overwrite the clipboard.
 * Returns the cleanup.
 */
export function copyOnSelect(t: XTerm, el: HTMLElement): () => void {
  let pressed = false;
  const down = (e: MouseEvent) => {
    pressed = e.button === 0;
  };
  // on the window: a drag may end outside the pane (xterm keeps selecting then too)
  const up = (e: MouseEvent) => {
    if (!pressed || e.button !== 0) return;
    pressed = false;
    if (!enabled()) return;
    // after xterm's own mouseup handler has finished the selection
    setTimeout(() => {
      const text = t.hasSelection() ? t.getSelection() : "";
      if (text) bridge().copyText(text).catch(() => {});
    });
  };
  el.addEventListener("mousedown", down);
  window.addEventListener("mouseup", up);
  return () => {
    el.removeEventListener("mousedown", down);
    window.removeEventListener("mouseup", up);
  };
}
