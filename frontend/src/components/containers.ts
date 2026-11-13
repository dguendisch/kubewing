import type { ContainerInfo } from "../transport/types";

/** One entry of the exec container picker. */
export interface ContainerChoice {
  name: string;
  /** "sidecar · running", "init · Completed" … */
  detail: string;
  default?: boolean;
  /** Why exec can't enter it; undefined = it can. */
  disabled?: string;
}

/**
 * The exec picker's entries: the pod's containers, then init, sidecar and
 * ephemeral ones (Go's order). Only running containers can be entered; a
 * state the pod status doesn't report yet doesn't block (Go and the kubelet
 * decide). Pure.
 */
export function containerChoices(cs: ContainerInfo[]): ContainerChoice[] {
  return cs.map((c) => {
    const state = c.reason ?? c.state;
    const detail = [c.kind === "container" ? "" : c.kind, state ?? "", c.default ? "default" : ""].filter(Boolean).join(" · ");
    const disabled = c.state && c.state !== "running" ? `not running${c.reason ? ` (${c.reason})` : ""}` : undefined;
    return { name: c.name, detail, default: c.default, disabled };
  });
}

/**
 * Whether s asks which container: only if there's more than one it could
 * enter. A single one (or none: Go reports why) goes straight to exec, as before.
 */
export function needsPicker(choices: ContainerChoice[]): boolean {
  return choices.filter((c) => !c.disabled).length > 1;
}

/** Initially highlighted: the default if it can be entered, else the first that can. */
export function initialChoice(choices: ContainerChoice[]): number {
  const d = choices.findIndex((c) => c.default && !c.disabled);
  return d >= 0 ? d : Math.max(0, choices.findIndex((c) => !c.disabled));
}

/** Moves the highlight by delta, skipping disabled entries; stays put at the ends. */
export function moveChoice(choices: { disabled?: string }[], index: number, delta: number): number {
  for (let i = index + delta; i >= 0 && i < choices.length; i += delta) if (!choices[i]!.disabled) return i;
  return index;
}
