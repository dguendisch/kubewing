import { describe, expect, it } from "vitest";
import { celContext, celFromLeaf, yamlLeaf } from "./cel";

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
  it("completes keys of the path before the dot", () => {
    expect(celContext("o.status.co", 11)).toEqual({ from: 9, word: "co", path: "status" });
    expect(celContext("o.", 2)).toEqual({ from: 2, word: "", path: "" });
    expect(celContext("o.spec.containers[0].im", 23)).toEqual({ from: 21, word: "im", path: "spec.containers" });
  });

  it("follows macro variables to their list", () => {
    const src = "o.spec.containers.exists(c, c.ima";
    expect(celContext(src, src.length)).toEqual({ from: src.length - 3, word: "ima", path: "spec.containers" });
  });

  it("has no field path for bare words and nothing inside strings", () => {
    expect(celContext("o.a == 1 && ha", 14)).toEqual({ from: 12, word: "ha" });
    expect(celContext('o.a == "x.y', 11)).toBeUndefined();
  });
});
