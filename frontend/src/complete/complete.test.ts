import { describe, expect, it } from "vitest";
import type { ResourceType } from "../transport/types";
import { findResource, namespaceCandidates, rank, resourceCandidates, score } from "./complete";

const rt = (name: string, group: string, kind: string, shortNames: string[] = [], namespaced = true): ResourceType => ({
  name,
  group,
  version: "v1",
  kind,
  singular: kind.toLowerCase(),
  shortNames,
  namespaced,
});

// same shapes as testdata/catalog.yaml
const types: ResourceType[] = [
  rt("pods", "", "Pod", ["po"]),
  rt("podtemplates", "", "PodTemplate"),
  rt("poddisruptionbudgets", "policy", "PodDisruptionBudget", ["pdb"]),
  rt("services", "", "Service", ["svc"]),
  rt("configmaps", "", "ConfigMap", ["cm"]),
  rt("secrets", "", "Secret"),
  rt("namespaces", "", "Namespace", ["ns"], false),
  rt("nodes", "", "Node", ["no"], false),
  rt("deployments", "apps", "Deployment", ["deploy"]),
  rt("daemonsets", "apps", "DaemonSet", ["ds"]),
  rt("customresourcedefinitions", "apiextensions.k8s.io", "CustomResourceDefinition", ["crd", "crds"], false),
  rt("shoots", "core.gardener.cloud", "Shoot"),
  rt("machines", "machine.sapcloud.io", "Machine", ["mach"]),
  rt("machines", "cluster.x-k8s.io", "Machine", ["ma"]),
];
const cands = resourceCandidates(types);
const top = (q: string, n = 3) => rank(q, cands).slice(0, n).map((m) => m.candidate.value);

describe("score tiers", () => {
  it("exact > prefix > word-start > substring > fuzzy > none", () => {
    const s = (q: string, t: string) => score(q, t).score;
    expect(s("pods", "pods")).toBeGreaterThan(s("pod", "pods"));
    expect(s("pod", "pods")).toBeGreaterThan(s("apps", "deployments.apps"));
    expect(s("apps", "deployments.apps")).toBeGreaterThan(s("ploy", "deployments"));
    expect(s("ploy", "deployments")).toBeGreaterThan(s("dpl", "deployments"));
    expect(s("dpl", "deployments")).toBeGreaterThan(0);
    expect(s("zz", "deployments")).toBe(0);
  });
  it("fuzzy matches always rank below substring matches and are flagged", () => {
    const long = "a".repeat(40);
    expect(score(long, long.split("").join("-")).score).toBeLessThan(score("x", "yx").score);
    expect(score("dpl", "deployments").fuzzy).toBe(true);
    expect(score("dep", "deployments").fuzzy).toBeFalsy();
  });
  it("highlights the label even when an alias ranked the match", () => {
    // "map" ties with the singular alias "configmap"; the label must still light up
    const hl = (q: string, v: string) => rank(q, cands).find((m) => m.candidate.value === v)?.hits;
    expect(hl("map", "configmaps")).toEqual([6, 7, 8]);
    expect(hl("maps", "configmaps")).toEqual([6, 7, 8, 9]);
    expect(hl("deploy", "deployments")).toEqual([0, 1, 2, 3, 4, 5]); // exact short name, prefix of label
    expect(hl("svc", "services")).toEqual([0, 3, 5]); // short name won; its letters still light up in the label
    expect(hl("gardener", "shoots")).toEqual([]); // only the qualified alias matches
  });
  it("highlights a matched short name in the detail", () => {
    const at = (q: string, v: string) => {
      const m = rank(q, cands).find((x) => x.candidate.value === v)!;
      return { label: m.hits, detail: m.detailHits.map((i) => m.candidate.detail![i]).join("") };
    };
    expect(at("pdb", "poddisruptionbudgets")).toEqual({ label: [0, 2, 13], detail: "pdb" });
    expect(at("PDB", "poddisruptionbudgets")).toEqual({ label: [0, 2, 13], detail: "pdb" });
    expect(at("pd", "poddisruptionbudgets")).toEqual({ label: [0, 2], detail: "pd" });
    expect(at("crds", "customresourcedefinitions").detail).toBe("crds"); // second short name
    expect(at("cr", "customresourcedefinitions").detail).toBe("cr"); // prefix of the first one
    expect(at("svc", "services").detail).toBe("svc");
    expect(at("pod", "pods")).toEqual({ label: [0, 1, 2], detail: "" }); // label match wins: nothing in detail
    expect(at("map", "configmaps")).toEqual({ label: [6, 7, 8], detail: "" }); // singular isn't shown
    expect(at("deploy", "deployments")).toEqual({ label: [0, 1, 2, 3, 4, 5], detail: "deploy" }); // both visible
  });
  it("highlights matched label characters", () => {
    expect(score("dpl", "deployments").hits).toEqual([0, 2, 3]);
    expect(score("ploy", "deployments").hits).toEqual([2, 3, 4, 5]);
  });
});

// Ranking goldens: what the user sees first for typical inputs.
describe("resource ranking", () => {
  it.each([
    ["po", ["pods", "podtemplates", "poddisruptionbudgets"]], // short name wins, then prefixes by length
    ["pod", ["pods", "podtemplates", "poddisruptionbudgets"]],
    ["svc", ["services"]],
    ["deploy", ["deployments"]],
    ["Deployment", ["deployments"]], // kind
    ["crd", ["customresourcedefinitions"]],
    ["ds", ["daemonsets"]],
    ["sh", ["shoots"]],
    ["gardener", ["shoots"]], // via qualified alias
  ])("%s → %j", (q, want) => {
    expect(top(q, want.length)).toEqual(want);
  });

  it("ambiguous plurals complete to qualified names", () => {
    expect(top("machines", 2).sort()).toEqual(["machines.cluster.x-k8s.io", "machines.machine.sapcloud.io"]);
    expect(top("ma", 1)).toEqual(["machines.cluster.x-k8s.io"]);
    expect(top("mach", 1)).toEqual(["machines.machine.sapcloud.io"]);
    expect(cands.find((c) => c.value === "machines.cluster.x-k8s.io")?.detail).toBe("namespaced · ma");
  });

  it("empty query lists everything in catalog order", () => {
    expect(rank("", cands, 100).map((m) => m.candidate.value)).toEqual(cands.map((c) => c.value));
  });

  it("shows group, scope and short names", () => {
    expect(cands.find((c) => c.value === "nodes")?.detail).toBe("core · cluster · no");
    expect(cands.find((c) => c.value === "deployments")?.detail).toBe("apps · namespaced · deploy");
  });

  it("respects the limit", () => {
    expect(rank("", cands, 2)).toHaveLength(2);
  });
});

describe("namespaces", () => {
  const ns = namespaceCandidates(["default", "garden", "kube-system", "shoot--foo--bar"]);
  it("all-namespaces entry first and reachable by 'all'", () => {
    expect(rank("", ns)[0]!.candidate.value).toBe("");
    expect(rank("all", ns)[0]!.candidate.value).toBe("");
  });
  it("matches inside names", () => {
    expect(rank("foo", ns).map((m) => m.candidate.value)).toEqual(["shoot--foo--bar"]);
    expect(rank("kube", ns)[0]!.candidate.value).toBe("kube-system");
  });
});

describe("findResource", () => {
  it("resolves names, short names, kinds and qualified names", () => {
    expect(findResource(types, "po")?.name).toBe("pods");
    expect(findResource(types, "Deployment")?.name).toBe("deployments");
    expect(findResource(types, "deployments.apps")?.name).toBe("deployments");
    expect(findResource(types, "machines.cluster.x-k8s.io")?.group).toBe("cluster.x-k8s.io");
  });
  it("is undefined when ambiguous or unknown", () => {
    expect(findResource(types, "machines")).toBeUndefined();
    expect(findResource(types, "nope")).toBeUndefined();
    expect(findResource(types, "")).toBeUndefined();
  });
});
