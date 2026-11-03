import { describe, expect, it } from "vitest";
import type { ContainerInfo } from "../transport/types";
import { checkDebug, checkDebugMany, commonTargets, imageSuggestions, initialDebug, profileCandidates, targetCandidates } from "./debugForm";

const pod: ContainerInfo[] = [
  { name: "app", kind: "container", state: "running" },
  { name: "side", kind: "container", state: "running", default: true },
  { name: "init", kind: "init", state: "terminated", reason: "Completed" },
  { name: "debugger-abcde", kind: "ephemeral", state: "terminated" },
];

describe("debug dialog", () => {
  it("prefills the configured image and profile, and targets the pod's default container", () => {
    expect(initialDebug({ image: "nicolaka/netshoot", profile: "netadmin" }, pod)).toEqual({ image: "nicolaka/netshoot", target: "side", profile: "netadmin" });
    expect(initialDebug(undefined, [pod[0]!]).target).toBe("app"); // no default flag: the first one
    expect(initialDebug(undefined, []).target).toBe(""); // none
  });

  it("without a configured image: empty, else the last one that started", () => {
    expect(initialDebug(undefined, pod)).toMatchObject({ image: "", profile: "general" });
    expect(initialDebug(undefined, pod, ["busybox", "alpine"]).image).toBe("busybox");
    expect(initialDebug({ image: "netshoot" }, pod, ["busybox"]).image).toBe("netshoot"); // the config wins
  });

  it("suggests the configured image first, then the history without duplicates", () => {
    expect(imageSuggestions({ image: "alpine" }, ["busybox", "alpine"])).toEqual(["alpine", "busybox"]);
    expect(imageSuggestions(undefined, [])).toEqual([]);
  });

  it("targets: every container but ephemeral ones, with kind and state", () => {
    expect(targetCandidates(pod)).toEqual([
      { value: "app", label: "app", detail: "running" },
      { value: "side", label: "side", detail: "running · default" },
      { value: "init", label: "init", detail: "init · Completed" },
    ]);
    expect(profileCandidates.map((c) => c.value)).toEqual(["general", "baseline", "restricted", "netadmin", "sysadmin"]);
    expect(profileCandidates[3]!.detail).toContain("tcpdump");
  });

  it("checks typed values before starting: an empty target is none, an empty profile general", () => {
    expect(checkDebug({ image: " busybox ", target: " side ", profile: "netadmin" }, pod)).toEqual({ opts: { image: "busybox", target: "side", profile: "netadmin" } });
    expect(checkDebug({ image: "busybox", target: "", profile: "" }, pod)).toEqual({ opts: { image: "busybox", target: "-", profile: "general" } });
    expect(checkDebug({ image: " ", target: "", profile: "" }, pod)).toEqual({ error: "an image is needed, e.g. busybox" });
    expect(checkDebug({ image: "busybox", target: "debugger-abcde", profile: "" }, pod)).toEqual({ error: 'no container "debugger-abcde" to target (app, side, init; empty = none)' });
    expect(checkDebug({ image: "busybox", target: "", profile: "root" }, pod)).toEqual({ error: 'unknown profile "root" (general, baseline, restricted, netadmin, sysadmin)' });
  });
});

describe("debug containers in many pods", () => {
  const a: ContainerInfo[] = [{ name: "app", kind: "container", default: true }, { name: "sidecar", kind: "container" }];
  const b: ContainerInfo[] = [{ name: "app", kind: "container", default: true }, { name: "dbg", kind: "ephemeral" }];
  const c: ContainerInfo[] = [{ name: "sidecar", kind: "container", default: true }, { name: "app", kind: "container" }];

  it("targets only containers every pod has, or none", () => {
    expect(commonTargets([a, b])).toEqual([
      { value: "app", label: "app", detail: "default of all" },
      { value: "-", label: "-", detail: "none: no shared processes" },
    ]);
    expect(commonTargets([a, c]).map((t) => [t.value, t.detail])).toEqual([["app", undefined], ["sidecar", undefined], ["-", "none: no shared processes"]]);
  });

  it("empty target: each pod's default; a container not in every pod is refused", () => {
    expect(checkDebugMany({ image: " busybox ", target: "", profile: "" }, [a, b])).toEqual({ opts: { image: "busybox", target: "", profile: "general" } });
    expect(checkDebugMany({ image: "busybox", target: "-", profile: "netadmin" }, [a, b])).toEqual({ opts: { image: "busybox", target: "-", profile: "netadmin" } });
    expect(checkDebugMany({ image: "busybox", target: "sidecar", profile: "" }, [a, b])).toMatchObject({ error: expect.stringContaining('not every pod has a container "sidecar"') });
    expect(checkDebugMany({ image: "", target: "", profile: "" }, [a])).toMatchObject({ error: expect.stringContaining("image") });
  });
});
