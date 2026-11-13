import type { ColumnInfo } from "../transport/types";

/**
 * Status colors: a cell's tone from its column and text, as kubecolor colors
 * kubectl's output, but per column, so a value only counts where it means a
 * state ("False" in READY, not in SUSPEND). Built-in rules only. Pure.
 */
export type Tone = "ok" | "warn" | "bad";

const rank: Record<Tone, number> = { ok: 0, warn: 1, bad: 2 };

function worst(a: Tone | undefined, b: Tone | undefined): Tone | undefined {
  if (!a) return b;
  if (!b) return a;
  return rank[b] > rank[a] ? b : a;
}

// a pod's, node's, claim's, namespace's, job's, CSR's (CONDITION) state; Gardener's shoot STATUS and extensions' lastOperation state
const states: Record<Tone, ReadonlySet<string>> = {
  ok: new Set(["Running", "Succeeded", "Completed", "Complete", "SuccessCriteriaMet", "Active", "Bound", "Ready", "Available", "Healthy", "healthy", "Established", "Approved", "Issued"]),
  warn: new Set(["Pending", "ContainerCreating", "PodInitializing", "Terminating", "Unknown", "unknown", "Progressing", "progressing", "Processing", "Released", "SchedulingDisabled", "Suspended", "NotReady"]),
  bad: new Set([
    "Failed", "Error", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "ErrImageNeverPull", "InvalidImageName",
    "OOMKilled", "Evicted", "CreateContainerError", "RunContainerError", "ContainerStatusUnknown", "StartError",
    "DeadlineExceeded", "BackoffLimitExceeded", "FailureTarget", "UnexpectedAdmissionError", "OutOfcpu", "OutOfmemory",
    "NodeAffinity", "NodeLost", "Lost", "Aborted", "Denied", "unhealthy", "Unhealthy",
  ]),
};

function stateTone(part: string): Tone | undefined {
  // an init container's state: waiting on init containers ("Init:0/2") is progress, an init container's error isn't
  if (part.startsWith("Init:")) return stateTone(part.slice(5)) === "bad" ? "bad" : "warn";
  // a container killed by a signal or exiting non-zero (kubectl's "Signal:9", "ExitCode:1")
  if (/^(Signal|ExitCode):/.test(part)) return "bad";
  if (part.endsWith("ConfigError")) return "bad"; // CreateContainerConfigError, a missing secret key …
  for (const t of ["bad", "warn", "ok"] as const) if (states[t].has(part)) return t;
  return undefined;
}

/** A state, or a comma list of them ("Ready,SchedulingDisabled", "Approved,Issued"): the worst part decides. */
function status(v: string): Tone | undefined {
  let t: Tone | undefined;
  for (const part of v.split(",")) t = worst(t, stateTone(part.trim()));
  return t;
}

/** A condition's status column ("True"/"False"; Gardener's shoot conditions may say "Progressing"). */
function condition(v: string): Tone | undefined {
  if (v === "True") return "ok";
  if (v === "False") return "bad";
  if (v === "Unknown" || v === "Progressing") return "warn";
  return undefined;
}

/** "n/m" ready: all ready ok, fewer not yet (warn); 0/0 nothing to be ready. Finished pods have 0/m: nothing to say then. */
function readyFraction(v: string, cells: readonly string[], columns: readonly ColumnInfo[]): Tone | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(v);
  if (!m) return undefined;
  const [n, of] = [Number(m[1]), Number(m[2])];
  if (of === 0) return undefined;
  if (n >= of) return "ok";
  const s = columns.findIndex((c) => c.name === "STATUS");
  if (s >= 0 && ["Completed", "Succeeded"].includes(cells[s] ?? "")) return undefined;
  return "warn";
}

/** A Gardener shoot's last operation, "Reconcile Succeeded (100%)". */
function lastOperation(v: string): Tone | undefined {
  if (/\b(Error|Failed|Aborted)\b/.test(v)) return "bad";
  if (/\b(Processing|Pending)\b/.test(v)) return "warn";
  if (/\bSucceeded\b/.test(v)) return "ok";
  return undefined;
}

type Rule = (v: string, cells: readonly string[], columns: readonly ColumnInfo[]) => Tone | undefined;

// condition columns: kubectl's, Gardener's managed resources (APPLIED, HEALTHY) and shoots (-o wide), Crossplane's SYNCED, CRDs' ESTABLISHED
const conditionColumns = ["AVAILABLE", "HEALTHY", "APPLIED", "APISERVER", "CONTROL", "NODES", "SYSTEM", "OBSERVABILITY", "SYNCED", "ESTABLISHED"];

const rules: Record<string, Rule> = {
  STATUS: status,
  PHASE: status,
  CONDITION: status,
  READY: (v, cells, columns) => readyFraction(v, cells, columns) ?? condition(v),
  ...Object.fromEntries(conditionColumns.map((c) => [c, condition])),
  // progressing is the state to watch, not the good one
  PROGRESSING: (v) => (v === "False" ? "ok" : v === "True" ? "warn" : undefined),
  "LAST OPERATION": lastOperation,
  // an event's type
  TYPE: (v) => (v === "Warning" ? "warn" : v === "Normal" ? "ok" : undefined),
};

/** The tone of a row's cell, if its column and text say one. */
export function tone(cells: readonly string[], col: number, columns: readonly ColumnInfo[]): Tone | undefined {
  const column = columns[col];
  const v = cells[col];
  if (!column || !v || column.type) return undefined; // typed columns (numbers, ages, restarts) have no states
  return rules[column.name]?.(v, cells, columns);
}
