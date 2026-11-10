import type { FontConfig } from "../transport/types";

/**
 * The app's one font (config.yaml `font`): its family in front of theme.css's
 * default stack (--font-mono), its base size and ligatures, the size zoomed
 * by ⌘+/⌘- for the session (zoomFont). applyFont sets the CSS variables the
 * DOM uses; the canvas grid, xterm and Monaco can't read CSS, so they take
 * font() whenever the config generation (themeGen) changes.
 */

export const DEFAULT_FONT_SIZE = 12;
/** font.size bounds (Go's MinFontSize/MaxFontSize); zoom stays within them too. */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 24;

/** What a font config resolves to. */
export interface AppliedFont {
  /** CSS font-family list: the configured families, then theme.css's default stack. */
  family: string;
  /** Base size in px; smaller UI text is 1-2px less. */
  size: number;
  ligatures: boolean;
}


// CSS generic families: never quoted (a quoted "monospace" names a font called so)
const generics = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong"]);

/** One entry of a font-family list: its name (unquoted) and whether it's a generic family. */
export interface Family {
  name: string;
  generic: boolean;
}

/** Splits a configured family ("JetBrainsMono Nerd Font" or `"Fira Code", Menlo`) into its entries. Pure. */
export function parseFamilies(family: string | undefined): Family[] {
  return (family ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const quoted = /^(["']).*\1$/.test(s);
      const name = quoted ? s.slice(1, -1) : s;
      return { name, generic: !quoted && generics.has(name.toLowerCase()) };
    });
}

/** The CSS font-family list: the configured families (quoted unless generic) before the default stack. Pure. */
export function fontStack(family: string | undefined, defaults: string): string {
  const own = parseFamilies(family).map((f) => (f.generic ? f.name : `"${f.name}"`));
  return [...own, defaults].filter(Boolean).join(", ");
}

/**
 * Text for a canvas with ligatures off: canvas text ignores CSS's
 * font-variant-ligatures (and WebKit has no other switch), so a zero-width
 * non-joiner goes between adjacent ASCII symbols, where coding ligatures form
 * ("->", "!=", "==="). Monospace ligatures keep the width of their characters,
 * so measuring the plain text stays right. Pure.
 */
export function unligate(text: string): string {
  return text.replace(/([!-/:-@[-`{-~])(?=[!-/:-@[-`{-~])/g, "$1‌");
}

const clampSize = (n: number) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n));

/** The size font.size shows at with a zoom offset (px), within the bounds. Pure. */
export function zoomedSize(base: number, zoom: number): number {
  return clampSize(base + zoom);
}

/**
 * The zoom offset after ⌘+ (1), ⌘- (-1) or ⌘0 (0). A step starts from the
 * size shown, so at a bound one step back is one px back (also after a
 * reload moved font.size nearer to it). Pure.
 */
export function zoomStep(base: number, zoom: number, step: 1 | -1 | 0): number {
  return step === 0 ? 0 : clampSize(zoomedSize(base, zoom) + step) - base;
}

let applied: AppliedFont | undefined;
let defaults: string | undefined;
let configured: FontConfig | undefined;
// the session's zoom (px on top of font.size): kept across reloads, never saved
let zoom = 0;

/**
 * theme.css's default stack, read before applyFont first overrides
 * --font-mono (it reads it first) and kept: the stylesheet doesn't change.
 */
function defaultStack(): string {
  return (defaults ??= getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace");
}

/** The font in effect: the configured one once applied, else theme.css's default. */
export function font(): AppliedFont {
  return (applied ??= { family: defaultStack(), size: DEFAULT_FONT_SIZE, ligatures: false });
}

/** Canvas row and header heights for the font size (22 and 24 at 12px). */
export function gridHeights(size: number): { row: number; header: number } {
  return { row: size + 10, header: size + 12 };
}

/**
 * Applies a font config: the CSS variables (--font-mono, --kw-font-size,
 * --kw-ligatures) and font() for the canvas, xterm and Monaco, the size
 * zoomed by the session's zoom. (Go reports a family that isn't installed:
 * WebKit's canvas can't see user fonts to tell.)
 */
export function applyFont(c: FontConfig | undefined) {
  configured = c;
  const root = document.documentElement.style;
  const family = fontStack(c?.family, defaultStack());
  const size = zoomedSize(c?.size || DEFAULT_FONT_SIZE, zoom);
  const ligatures = !!c?.ligatures;
  applied = { family, size, ligatures };
  if (c?.family) root.setProperty("--font-mono", family);
  else root.removeProperty("--font-mono");
  root.setProperty("--kw-font-size", `${size}px`);
  root.setProperty("--kw-ligatures", ligatures ? "normal" : "none");
}

/**
 * Zooms the font one px in (1) or out (-1), or back to font.size (0), in
 * every pane and tab, for as long as kubewing runs (a reload of the config
 * keeps it). Reports whether the size changed: the caller then bumps the
 * config generation, which the canvas grid, xterm and Monaco re-read.
 */
export function zoomFont(step: 1 | -1 | 0): boolean {
  const before = font().size;
  zoom = zoomStep(configured?.size || DEFAULT_FONT_SIZE, zoom, step);
  applyFont(configured);
  return font().size !== before;
}
