import type * as Monaco from "monaco-editor/editor/editor.api.js";

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | undefined;

/** Loads Monaco on first use (it's ~2 MB; the table view never needs it). */
export function loadMonaco(): Promise<MonacoApi> {
  return (loading ??= import("./monaco").then((m) => m.monaco));
}
