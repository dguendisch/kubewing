import { describe, expect, it } from "vitest";
import type { NodeInfo } from "../transport/types";
import { checkOpsPod, initialOpsPod, nodeCandidates, nodeDetail, opsImageSuggestions, opsNamespaceCandidates, opsPodHint } from "./opsPodForm";

const nodes: NodeInfo[] = [
  { name: "n-a", ready: "True", pool: "worker-a", zone: "eu-1a" },
  { name: "n-b", ready: "True", pool: "worker-a", zone: "eu-1b", unschedulable: true },
  { name: "n-c", ready: "Unknown", pool: "etcd" },
  { name: "n-d" },
];
const opts = { image: "ops-toolbelt", namespace: "", hostRoot: false, chroot: false, hostNetwork: false };

describe("ops pod dialog", () => {
  it("prefills what Go decided (last used, else config.yaml); without an answer host root + host network", () => {
    expect(initialOpsPod({ image: "tb", namespace: "kube-system", chroot: true, hostRoot: false, hostNetwork: false, remembered: true })).toEqual({ image: "tb", namespace: "kube-system", hostRoot: true, chroot: true, hostNetwork: false });
    expect(initialOpsPod(undefined)).toEqual({ image: "", namespace: "", hostRoot: true, chroot: false, hostNetwork: true });
  });

  it("completes namespaces from the catalog, the last used one first", () => {
    expect(opsNamespaceCandidates(["default", "kube-system"], "kube-system").map((c) => [c.value, c.detail])).toEqual([["kube-system", "last used"], ["default", undefined]]);
    expect(opsNamespaceCandidates([], "ops").map((c) => c.value)).toEqual(["ops"]); // not listed (yet): still offered
    expect(opsNamespaceCandidates(["a"], "").map((c) => c.value)).toEqual(["a"]);
  });

  it("offers the configured image first, then the history shared with debug containers", () => {
    expect(opsImageSuggestions({ image: "tb" }, ["busybox", "tb"])).toEqual(["tb", "busybox"]);
    expect(opsImageSuggestions(undefined, [])).toEqual([]);
  });

  it("describes nodes by readiness, pool, zone and cordon", () => {
    expect(nodeCandidates(nodes).map((c) => c.detail)).toEqual(["worker-a · eu-1a", "worker-a · eu-1b · cordoned", "not ready (unknown) · etcd", undefined]);
    expect(nodeDetail({ name: "x", ready: "False" })).toBe("not ready");
  });

  it("checks node, image and namespace; chroot implies the host root mount", () => {
    expect(checkOpsPod(" n-b ", { ...opts, chroot: true }, nodes)).toEqual({ node: "n-b", opts: { ...opts, hostRoot: true, chroot: true } });
    expect(checkOpsPod("", opts, nodes)).toEqual({ error: "a node is needed" });
    expect(checkOpsPod("n-x", opts, nodes)).toEqual({ error: 'no node "n-x" (↓ lists them)' });
    // nodes not known (still listing, no permission): Go decides
    expect(checkOpsPod("n-x", opts, [])).toMatchObject({ node: "n-x" });
    expect(checkOpsPod("n-x", opts, undefined)).toMatchObject({ node: "n-x" });
    expect(checkOpsPod("n-a", { ...opts, image: " " }, nodes)).toEqual({ error: "an image is needed, e.g. the ops-toolbelt" });
    expect(checkOpsPod("n-a", { ...opts, image: "a b" }, nodes)).toEqual({ error: '"a b" is not an image' });
    expect(checkOpsPod("n-a", { ...opts, namespace: "Kube_System" }, nodes)).toEqual({ error: '"Kube_System" is not a namespace name' });
  });

  it("the hint says what the pod gets", () => {
    expect(opsPodHint(opts)).toBe("privileged, host PID · deleted when the shell ends");
    expect(opsPodHint({ ...opts, hostRoot: true, chroot: true, hostNetwork: true })).toBe("privileged, host PID · node's / at /host, shell chrooted into it · host network · deleted when the shell ends");
  });
});
