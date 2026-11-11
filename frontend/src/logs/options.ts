/**
 * The log dialog's form (l): which containers, how much history, follow,
 * the previous instance, timestamps. Pure, so the parsing is a unit test rather than a dialog.
 */
import type { LogsOptions } from "../transport/types";

export interface LogForm {
  /** Every container the target's pods have, in their order. */
  containers: string[];
  /** The ones checked. */
  picked: string[];
  /** "100" = the last 100 lines, "10m" / "1h30m" = since then, "all" = everything. */
  history: string;
  follow: boolean;
  /** The previous, terminated instance of each container (kubectl logs -p); read once, so it overrides follow. */
  previous: boolean;
  timestamps: boolean;
  /** A log pane per pod instead of one tail over all (offered with 2 or more pods). */
  perPod: boolean;
  /** With perPod: the panes in a new tab, not below. */
  newTab: boolean;
}

/** At most this many panes for a pane per pod (as debug containers at once). */
export const maxLogPanes = 8;

/** Why a pane per pod isn't offered for these many pods (undefined = it is). */
export function perPodUnavailable(pods: number): string | undefined {
  if (pods < 2) return "one pod";
  if (pods > maxLogPanes) return `${pods} pods, at most ${maxLogPanes} panes`;
}

/** The dialog's defaults: every container, the configured tail, following the current instance, no timestamps. */
export function initialLogForm(containers: string[], tail: number): LogForm {
  return { containers, picked: [...containers], history: String(tail), follow: true, previous: false, timestamps: false, perPod: false, newTab: false };
}

/** Toggles one container; the others keep their state. */
export function toggleContainer(f: LogForm, name: string): LogForm {
  const picked = f.picked.includes(name) ? f.picked.filter((c) => c !== name) : f.containers.filter((c) => c === name || f.picked.includes(c));
  return { ...f, picked };
}

/** All or none: all unless every one is checked already. */
export function toggleAllContainers(f: LogForm): LogForm {
  return { ...f, picked: f.picked.length === f.containers.length ? [] : [...f.containers] };
}

// a Go duration, as kubectl's --since: units h, m, s (combinable, "1h30m"), decimals allowed
const duration = /^(\d+(\.\d+)?(h|m|s|ms))+$/;

/** The history field as LogsOptions fields, or what's wrong with it. */
export function parseHistory(h: string): Pick<LogsOptions, "tail" | "since" | "all"> | string {
  const v = h.trim().toLowerCase();
  if (v === "all") return { all: true };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n > 0 ? { tail: n } : "the number of lines must be at least 1";
  }
  if (duration.test(v) && !/^(0+(\.0+)?(h|m|s|ms))+$/.test(v)) return { since: v };
  return "lines (100), a duration (10m, 1h30m) or all";
}

/** The form as the bridge's options, or the first thing wrong with it. */
export function checkLogForm(f: LogForm): LogsOptions | string {
  if (f.containers.length && !f.picked.length) return "pick at least one container";
  const h = parseHistory(f.history);
  if (typeof h === "string") return h;
  // every container checked: none named, so containers of pods that appear later are followed too
  const containers = f.picked.length === f.containers.length ? undefined : f.picked;
  // the previous instance's logs don't grow: read once
  return { ...h, containers, follow: f.follow && !f.previous, ...(f.previous ? { previous: true } : {}) };
}
