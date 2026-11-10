import { create } from "zustand";
import { defaultBindings, mergeBindings, type Binding } from "../keys/keymap";
import type { Config } from "../transport/types";
import { DEFAULT_SCROLLBACK, sessions } from "../term/sessions";
import { DEFAULT_LOG_BUFFER, logBuffers } from "../logs/buffer";
import { applyFont } from "./font";

/** Theme tokens defined in theme.css (without "--color-"); theme files may override these. */
export const themeTokens = [
  "bg",
  "bg-elev",
  "bg-hover",
  "border",
  "fg",
  "fg-muted",
  "accent",
  "added",
  "connected",
  "deleted",
  "changed",
  "hidden",
  "match",
  "marked",
  "prod",
  "shadow",
] as const;

export interface ConfigState {
  config?: Config;
  /** Default bindings merged with keybindings.yaml. */
  bindings: Binding[];
  /** Go-side load errors plus frontend validation (keybindings, theme tokens). */
  errors: string[];
  dismissed: boolean;
  /** Bumped whenever the config is applied (theme tokens, font): the canvas grid, xterm and Monaco re-read colors and font on change. */
  themeGen: number;
}

export const useConfig = create<ConfigState>(() => ({ bindings: defaultBindings, errors: [], dismissed: false, themeGen: 0 }));

/** Validates and merges a loaded config. Pure. */
export function resolveConfig(c: Config): Pick<ConfigState, "bindings" | "errors"> & { theme: Record<string, string> } {
  const { bindings, errors } = mergeBindings(defaultBindings, c.keybindings);
  const known = new Set<string>(themeTokens);
  const theme: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.theme)) {
    if (known.has(k)) theme[k] = v;
    else errors.push(`themes/${c.config.theme}.yaml: unknown token "${k}" (known: ${themeTokens.join(", ")})`);
  }
  return { bindings, errors: [...c.errors, ...errors], theme };
}

/** Applies a loaded config: keymap, theme CSS variables, font, error banner. */
export function applyConfig(c: Config) {
  const r = resolveConfig(c);
  const style = document.documentElement.style;
  for (const t of themeTokens) {
    if (r.theme[t]) style.setProperty(`--color-${t}`, r.theme[t]);
    else style.removeProperty(`--color-${t}`);
  }
  applyFont(c.config.font);
  sessions.setScrollback(c.config.terminal?.scrollback ?? DEFAULT_SCROLLBACK);
  logBuffers.setMax(c.config.logs?.buffer ?? DEFAULT_LOG_BUFFER);
  useConfig.setState((s) => ({ config: c, bindings: r.bindings, errors: r.errors, dismissed: false, themeGen: s.themeGen + 1 }));
}
