import { describe, expect, it } from "vitest";
import { locationNamespace, locationParts, locationTitle, planeIcon } from "./location";
import { tabTitle } from "./tabTitle";
import type { PaneState } from "../store/state";
import type { Location } from "../transport/types";

const text = (l: Location) => {
  const p = locationParts(l)!;
  return [...p.before.map((c) => c.text), `[${p.plane}]`, p.name, ...p.after.map((c) => c.text)].filter(Boolean).join(" ");
};

describe("locationParts", () => {
  it("is nothing for clusters that aren't Gardener's", () => {
    expect(locationParts(undefined)).toBeUndefined();
    expect(locationParts({})).toBeUndefined();
  });

  it("names landscape, seed and plane; a seed's kind when known", () => {
    expect(text({ garden: "live", plane: "shoot", project: "foo", shoot: "bar", seed: "aws" })).toBe("live seed aws [shoot] foo/bar");
    expect(text({ garden: "live", plane: "controlPlane", project: "foo", shoot: "bar", seed: "aws", seedKind: "managed", seedShoot: "aws", seedHost: "root" })).toBe("live seed aws [controlPlane] foo/bar");
    expect(text({ garden: "live", plane: "seed", seed: "aws", seedKind: "managed", seedShoot: "aws-shoot", seedHost: "root" })).toBe("live [seed] aws managed · shoot garden/aws-shoot on seed root");
    expect(text({ garden: "live", plane: "seed", seed: "gke", seedKind: "unmanaged" })).toBe("live [seed] gke unmanaged");
    expect(text({ garden: "live", plane: "seed", seed: "gke" })).toBe("live [seed] gke");
    expect(text({ garden: "live", plane: "shoot", project: "garden", shoot: "aws", seed: "root", isSeed: "aws" })).toBe("live seed root [shoot] garden/aws is seed aws");
    expect(text({ garden: "live", plane: "garden", project: "foo" })).toBe("live [garden] project foo");
  });

  it("opens the landscape, seeds and a managed seed's shoot", () => {
    const cp = locationParts({ garden: "live", plane: "controlPlane", project: "foo", shoot: "bar", seed: "aws" })!;
    expect(cp.before.map((c) => c.open)).toEqual([{ garden: "live", project: "foo" }, { garden: "live", seed: "aws" }]);
    const seed = locationParts({ garden: "live", plane: "seed", seed: "aws", seedKind: "managed", seedShoot: "aws", seedHost: "root" })!;
    expect(seed.after.filter((c) => c.open).map((c) => c.open)).toEqual([{ garden: "live", namespace: "garden", shoot: "aws" }, { garden: "live", seed: "root" }]);
    // on the garden itself, the landscape isn't a way anywhere else
    expect(locationParts({ garden: "live", plane: "garden" })!.before[0]!.open).toBeUndefined();
  });

  it("tells everything in the tooltip", () => {
    const t = locationTitle({ garden: "live", plane: "controlPlane", project: "foo", shoot: "bar", seed: "aws", seedKind: "unmanaged" });
    expect(t).toContain("landscape: garden live");
    expect(t).toContain("seed: aws (unmanaged seed)");
    expect(t).toContain("namespace shoot--foo--bar on the seed");
    expect(t).toContain("⌥⌘O");
  });
});

describe("plane in the tab", () => {
  const pane = (p: Partial<PaneState>): PaneState => ({ id: "v1", selected: 0, spec: { context: "c", resource: "pods", namespace: "kube-system", labelSelector: "", grep: "", filter: "" }, ...p });

  it("leads with the plane's mark, after the safety label", () => {
    const l: Location = { garden: "live", plane: "controlPlane", project: "foo", shoot: "bar", seed: "aws" };
    expect(tabTitle(undefined, pane({}), { context: "c", label: "LIVE", confirm: [] }, planeIcon(l))).toBe("LIVE · ⛭ pods · kube-system");
    expect(tabTitle({ id: "t", layout: { kind: "leaf", pane: "v1" } as never, focused: "v1", name: "mine" }, pane({}), undefined, planeIcon(l))).toBe("⛭ mine");
    expect(tabTitle(undefined, pane({}), undefined, planeIcon({}))).toBe("pods · kube-system");
  });

  it("asks by the namespace that tells the plane", () => {
    expect(locationNamespace(pane({}))).toBe("kube-system");
    expect(locationNamespace(pane({ term: { session: "s", pod: "", container: "", context: "c", local: { namespace: "shoot--a--b" } } }))).toBe("shoot--a--b");
    expect(locationNamespace(pane({ term: { session: "s", pod: "", container: "", context: "c", local: {} } }))).toBe("kube-system");
    expect(locationNamespace(pane({ term: { session: "s", pod: "p", container: "c", context: "c", ops: { node: "n", namespace: "kube-system", image: "i" } } }))).toBe("");
  });
});
