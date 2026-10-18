/** Viewport rectangle. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Row locators registered by mounted tables (server pane id → row → its
 * on-screen box, or undefined while scrolled out of view). Lets commands
 * anchor overlays to a row without threading grid refs through React.
 */
export const rowLocators = new Map<string, { row: (index: number) => Box | undefined; viewport: () => Box | undefined }>();

/** How the menu is anchored: to a row (⌘⏎), or to a pointer position (right-click). */
export type Anchor = { kind: "row"; row: Box; viewport: Box } | { kind: "point"; x: number; y: number };

/**
 * Places a menu of the given size. Pure.
 * - row: just below the row, flush with its left edge, like a dropdown;
 *   above it when there's no room below (if neither fits, the side with
 *   more room). A row scrolled out of the pane's
 *   viewport is clamped to the viewport's edge, so the menu stays visually
 *   attached to the pane.
 * - point: at the pointer, flipped left/up when it would overflow.
 * Always kept inside the window with a small margin.
 */
export function placeMenu(a: Anchor, menu: { width: number; height: number }, win: { width: number; height: number }, margin = 4): { x: number; y: number; above: boolean } {
  let x: number;
  let y: number;
  let above = false;
  if (a.kind === "point") {
    x = a.x + menu.width + margin > win.width ? a.x - menu.width : a.x;
    above = a.y + menu.height + margin > win.height && a.y - menu.height >= margin;
    y = above ? a.y - menu.height : a.y;
  } else {
    const v = a.viewport;
    const top = Math.min(Math.max(a.row.y, v.y), v.y + v.height);
    const bottom = Math.min(Math.max(a.row.y + a.row.height, v.y), v.y + v.height);
    x = a.row.x;
    const roomBelow = win.height - margin - bottom;
    const roomAbove = top - margin;
    // below if it fits there, else above if it fits; neither: the side with more room (then clamped)
    above = roomBelow < menu.height && (roomAbove >= menu.height || roomAbove > roomBelow);
    y = above ? top - menu.height : bottom;
  }
  // clamp into the window; if it can't fit at all, its start (left/top) stays visible
  x = Math.max(margin, Math.min(x, win.width - menu.width - margin));
  y = Math.max(margin, Math.min(y, win.height - menu.height - margin));
  return { x, y, above };
}
