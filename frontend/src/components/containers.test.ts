import { describe, expect, it } from "vitest";
import type { ContainerInfo } from "../transport/types";
import { containerChoices, initialChoice, moveChoice, needsPicker } from "./containers";

// as web-4 of the e2e-static tape
const pod: ContainerInfo[] = [
  { name: "app", kind: "container", state: "running", default: true },
  { name: "worker", kind: "container", state: "waiting", reason: "CrashLoopBackOff" },
  { name: "setup", kind: "init", state: "terminated", reason: "Completed" },
  { name: "proxy", kind: "sidecar", state: "running" },
];

describe("exec container picker", () => {
  it("labels kind, state and the default; only running containers can be entered", () => {
    expect(containerChoices(pod)).toEqual([
      { name: "app", detail: "running · default", default: true, disabled: undefined },
      { name: "worker", detail: "CrashLoopBackOff", default: undefined, disabled: "not running (CrashLoopBackOff)" },
      { name: "setup", detail: "init · Completed", default: undefined, disabled: "not running (Completed)" },
      { name: "proxy", detail: "sidecar · running", default: undefined, disabled: undefined },
    ]);
  });

  it("an unreported state doesn't block (the pod status may lag)", () => {
    const c = containerChoices([{ name: "app", kind: "container", default: true }, { name: "dbg", kind: "ephemeral" }]);
    expect(c.map((x) => [x.detail, x.disabled])).toEqual([["default", undefined], ["ephemeral", undefined]]);
  });

  it("asks only when more than one container can be entered", () => {
    expect(needsPicker(containerChoices(pod))).toBe(true);
    expect(needsPicker(containerChoices([pod[0]!]))).toBe(false);
    expect(needsPicker(containerChoices([pod[0]!, pod[1]!, pod[2]!]))).toBe(false); // the others aren't running
    expect(needsPicker([])).toBe(false);
  });

  it("starts on the default, else the first enterable one", () => {
    expect(initialChoice(containerChoices(pod))).toBe(0);
    const crashedDefault = containerChoices([{ ...pod[1]!, default: true }, pod[3]!, pod[0]!].map((c, i) => (i ? { ...c, default: false } : c)));
    expect(initialChoice(crashedDefault)).toBe(1);
    expect(initialChoice([])).toBe(0);
  });

  it("moving skips what can't be entered and stops at the ends", () => {
    const c = containerChoices(pod);
    expect(moveChoice(c, 0, 1)).toBe(3);
    expect(moveChoice(c, 3, 1)).toBe(3);
    expect(moveChoice(c, 3, -1)).toBe(0);
    expect(moveChoice(c, 0, -1)).toBe(0);
  });
});
