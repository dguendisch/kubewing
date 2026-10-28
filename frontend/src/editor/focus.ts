/**
 * The Monaco viewer or editor, or the terminal, that should have the keys
 * (the focused pane's). A layout change moves pane elements in the DOM (dockview
 * re-parents a pane whose sibling closed), which drops the browser focus to
 * the body: the dock gives it back to this one afterwards.
 */
let current: (() => void) | undefined;

/** Called while an editor should have the keys; returns its release. */
export function claimFocus(focus: () => void): () => void {
  current = focus;
  return () => {
    if (current === focus) current = undefined;
  };
}

/** After a layout change: the focus back to the editor that should have it, if it fell to nothing. */
export function refocusEditor() {
  const a = document.activeElement;
  if (a && a !== document.body) return;
  current?.();
}
