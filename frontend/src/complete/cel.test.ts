import { describe, expect, it } from "vitest";
import { celContext, celFromLeaf, keyCandidates, operatorCandidates, yamlLeaf } from "./cel";

// as sigs.k8s.io/yaml marshals a pod (lists at their key's column)
const pod = `apiVersion: v1
kind: Pod
metadata:
  annotations: {}
  labels:
    app: etcd
    app.kubernetes.io/name: etcd
  name: etcd-0
spec:
  containers:
  - args:
    - --a
    - --b
    image: etcd:3.5
    name: etcd
    ports:
    - containerPort: 2379
      name: client
  - image: busybox
    name: side
  nodeName: worker-1
  tolerations:
  - key: k
    operator: Exists
status:
  conditions:
  - status: "True"
    type: Ready
  phase: Running
  ready: true`.split("\n");

// the line whose content (after indentation, and after "- " unless asked for) is text
const at = (text: string) => pod.findIndex((l) => l.trim() === text || (!text.startsWith("-") && l.trim().replace(/^(- )+/, "") === text));
const filterAt = (text: string, op: "==" | "!=" = "==") => {
  const leaf = yamlLeaf(pod, at(text));
  return leaf && celFromLeaf(leaf, op);
};

describe("yamlLeaf", () => {
  it("resolves paths through maps and Go-style lists", () => {
    expect(yamlLeaf(pod, at("kind: Pod"))).toEqual({ path: [{ key: "kind" }], value: "Pod" });
    expect(yamlLeaf(pod, at("nodeName: worker-1"))).toEqual({ path: [{ key: "spec" }, { key: "nodeName" }], value: "worker-1" });
    expect(yamlLeaf(pod, at("image: busybox"))!.path).toEqual([{ key: "spec" }, { key: "containers" }, { index: -1 }, { key: "image" }]);
    expect(yamlLeaf(pod, at("image: etcd:3.5"))).toEqual({ path: [{ key: "spec" }, { key: "containers" }, { index: -1 }, { key: "image" }], value: "etcd:3.5" });
    expect(yamlLeaf(pod, at("name: client"))!.path).toEqual([{ key: "spec" }, { key: "containers" }, { index: -1 }, { key: "ports" }, { index: -1 }, { key: "name" }]);
    expect(yamlLeaf(pod, at("- --b"))).toEqual({ path: [{ key: "spec" }, { key: "containers" }, { index: -1 }, { key: "args" }, { index: -1 }], value: "--b" });
    expect(yamlLeaf(pod, at("phase: Running"))!.path).toEqual([{ key: "status" }, { key: "phase" }]);
  });

  it("parses scalars like YAML does", () => {
    expect(yamlLeaf(pod, at("- containerPort: 2379"))!.value).toBe(2379);
    expect(yamlLeaf(pod, at('- status: "True"'))!.value).toBe("True");
    expect(yamlLeaf(pod, at("ready: true"))!.value).toBe(true);
  });

  it("treats block scalar content as text, not fields", () => {
    const cm = ["data:", "  config.yaml: |", "    foo: bar", "    - x", "  other: v"];
    expect(yamlLeaf(cm, 2)).toBeUndefined();
    expect(yamlLeaf(cm, 3)).toBeUndefined();
    expect(yamlLeaf(cm, 4)).toEqual({ path: [{ key: "data" }, { key: "other" }], value: "v" });
    expect(yamlLeaf(cm, 1)).toEqual({ path: [{ key: "data" }, { key: "config.yaml" }] });
  });

  it("has no value for containers and empty maps", () => {
    expect(yamlLeaf(pod, at("spec:"))).toEqual({ path: [{ key: "spec" }] });
    expect(yamlLeaf(pod, at("annotations: {}"))!.value).toBeUndefined();
    expect(yamlLeaf(pod, 999)).toBeUndefined();
  });
});

describe("celFromLeaf", () => {
  it("builds == with exists() for list steps and [\"…\"] for odd keys", () => {
    expect(filterAt("nodeName: worker-1")).toBe('o.spec.nodeName == "worker-1"');
    expect(filterAt("app.kubernetes.io/name: etcd")).toBe('o.metadata.labels["app.kubernetes.io/name"] == "etcd"');
    // reserved words other than in/true/false/null are plain field names in cel-go
    expect(celFromLeaf({ path: [{ key: "metadata" }, { key: "namespace" }], value: "ns" }, "==")).toBe('o.metadata.namespace == "ns"');
    expect(celFromLeaf({ path: [{ key: "in" }], value: 1 }, "==")).toBe('o["in"] == 1');
    expect(filterAt("image: busybox")).toBe('o.spec.containers.exists(x, x.image == "busybox")');
    expect(filterAt("name: client")).toBe('o.spec.containers.exists(x, x.ports.exists(y, y.name == "client"))');
    expect(filterAt("- --b")).toBe('o.spec.containers.exists(x, x.args.exists(y, y == "--b"))');
    expect(filterAt("- containerPort: 2379")).toBe("o.spec.containers.exists(x, x.ports.exists(y, y.containerPort == 2379))");
  });

  it("builds != so objects without the field still match", () => {
    expect(filterAt("nodeName: worker-1", "!=")).toBe('o.?spec.?nodeName != optional.of("worker-1")');
    expect(filterAt("app.kubernetes.io/name: etcd", "!=")).toBe('o.?metadata.?labels[?"app.kubernetes.io/name"] != optional.of("etcd")');
    expect(filterAt("image: busybox", "!=")).toBe('!o.?spec.?containers.orValue([]).exists(x, x.image == "busybox")');
  });

  it("has nothing for lines without a scalar", () => {
    expect(filterAt("spec:")).toBeUndefined();
  });
});

describe("celContext", () => {
  const dot = { bracket: false, optional: false };
  it("completes keys of the path before the dot (from the dot on)", () => {
    expect(celContext("o.status.co", 11)).toEqual({ from: 8, word: "co", path: ["status"], access: dot });
    expect(celContext("o.", 2)).toEqual({ from: 1, word: "", path: [], access: dot });
    expect(celContext("o.spec.containers[0].im", 23)).toEqual({ from: 20, word: "im", path: ["spec", "containers"], access: dot });
    expect(celContext("o.?spec.?co", 11)).toEqual({ from: 7, word: "co", path: ["spec"], access: { bracket: false, optional: true } });
  });

  it("follows macro variables to their list", () => {
    const src = "o.spec.containers.exists(c, c.ima";
    expect(celContext(src, src.length)).toEqual({ from: src.length - 4, word: "ima", path: ["spec", "containers"], access: dot });
    const nested = 'o.metadata["owner-refs"].exists(r, r.na';
    expect(celContext(nested, nested.length)!.path).toEqual(["metadata", "owner-refs"]);
  });

  it("reads bracketed keys as one step each, and completes inside an open [\"", () => {
    const after = 'o.metadata.labels["app.kubernetes.io/name"].';
    expect(celContext(after, after.length)!.path).toEqual(["metadata", "labels", "app.kubernetes.io/name"]);
    const open = 'o.metadata.labels["app.k';
    expect(celContext(open, open.length)).toEqual({ from: 17, word: "app.k", path: ["metadata", "labels"], access: { bracket: true, optional: false } });
    const opt = 'o.?metadata.?labels[?"ap';
    expect(celContext(opt, opt.length)).toEqual({ from: 19, word: "ap", path: ["metadata", "labels"], access: { bracket: true, optional: true } });
    // a string that isn't a key: nothing
    expect(celContext('o.a == "x', 9)).toBeUndefined();
    expect(celContext('o.a.contains("x', 15)).toBeUndefined();
  });

  it("has no field path for bare words and nothing inside strings", () => {
    expect(celContext("o.a == 1 && ha", 14)).toEqual({ from: 12, word: "ha" });
    expect(celContext('o.a == "x.y', 11)).toBeUndefined();
  });
});

describe("operator completion", () => {
  const at = (src: string) => celContext(src, src.length);

  it("opens after a field and a space, or on an operator character", () => {
    expect(at("o.status.phase ")).toEqual({ from: 15, word: "", operator: { path: ["status", "phase"] } });
    expect(at("o.status.phase =")).toEqual({ from: 15, word: "=", operator: { path: ["status", "phase"] } });
    expect(at("o.status.phase!=")).toEqual({ from: 14, word: "!=", operator: { path: ["status", "phase"] } });
    expect(at("o.status.phase i")).toEqual({ from: 15, word: "i", operator: { path: ["status", "phase"] } });
    expect(at("o.spec.containers[0].image ")!.operator).toEqual({ path: ["spec", "containers", "image"] });
    expect(at('o.metadata.labels["app.kubernetes.io/name"] ')!.operator).toEqual({ path: ["metadata", "labels", "app.kubernetes.io/name"] });
  });

  it("follows macro variables", () => {
    expect(at("o.spec.containers.exists(c, c.image ")!.operator).toEqual({ path: ["spec", "containers", "image"] });
  });

  it("knows literals and calls, not their type", () => {
    expect(at('o.a == "x" ')!.operator).toEqual({ literal: true });
    expect(at("o.a > 1e3 ")!.operator).toEqual({ literal: true });
    expect(at("o.a == true ")!.operator).toEqual({ literal: true });
    expect(at("size(o.a) ")!.operator).toEqual({});
  });

  it("stays out of the way of keys, operands and strings", () => {
    expect(at("o.status")!.operator).toBeUndefined();
    expect(at("o.a == ")).toEqual({ from: 7, word: "" });
    expect(at("o.a in ")).toEqual({ from: 7, word: "" });
    expect(at("o.a == 1 && ha")).toEqual({ from: 12, word: "ha" });
    expect(at("!")).toEqual({ from: 1, word: "" });
    expect(at('o.a == "x =')).toBeUndefined();
  });

  it("offers what fits the type", () => {
    const labels = (type?: string, literal = false) => operatorCandidates({ literal }, type).map((c) => c.label);
    expect(labels("string")).toEqual(["==", "!=", "in […]", "<", "<=", ">", ">="]);
    expect(labels("int").slice(0, 3)).toEqual(["==", "!=", "<"]);
    expect(labels("bool")).toEqual(["&&", "||", "==", "!="]);
    expect(labels("map")).toEqual(["==", "!="]);
    expect(labels(undefined, true)).toEqual(["&&", "||", "in"]);
    expect(labels()).toContain("&&");
    expect(operatorCandidates({}, "string")[0]!.value).toBe("== ");
  });
});

describe("key candidates", () => {
  const f = {
    objects: 3,
    keys: [
      { key: "app", type: "string", count: 3 },
      { key: "app.kubernetes.io/name", type: "string", count: 2 },
      { key: "x-prop", type: "string", count: 1 },
      { key: "namespace", type: "string", count: 3 },
      { key: "in", type: "string", count: 1 },
    ],
  };
  const values = (src: string) => keyCandidates(f, celContext(src, src.length)!).map((c) => c.value);

  it("brackets keys that aren't identifiers, or that CEL reads as an operator or literal", () => {
    // the label is the key as it is; the value is what goes in
    expect(values("o.metadata.labels.").slice(0, 5)).toEqual([".app", '["app.kubernetes.io/name"]', '["x-prop"]', ".namespace", '["in"]']);
    expect(keyCandidates(f, celContext("o.metadata.labels.", 18)!)[1]!.label).toBe("app.kubernetes.io/name");
  });

  it("keeps the optional form and the bracket the user opened", () => {
    expect(values("o.?metadata.?labels.?")).toEqual([".?app", '[?"app.kubernetes.io/name"]', '[?"x-prop"]', ".?namespace", '[?"in"]']);
    expect(values('o.metadata.labels["')).toEqual(['["app"]', '["app.kubernetes.io/name"]', '["x-prop"]', '["namespace"]', '["in"]']);
  });

  it("adds member functions after a plain dot below the top level", () => {
    expect(values("o.metadata.labels.")).toContain(".exists(x, ");
    expect(values("o.")).not.toContain(".exists(x, ");
    expect(values('o.metadata.labels["')).not.toContain(".exists(x, ");
  });
});
