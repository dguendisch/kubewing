import { describe, expect, it } from "vitest";
import { sameLine } from "./carry";

const yaml = ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: a", '  resourceVersion: "1"', "data:", '  x: "1"', '  y: "2"'].join("\n");

describe("sameLine", () => {
  it("keeps the line when the texts are the same", () => {
    expect(sameLine(yaml, 6, yaml)).toBe(6);
  });

  it("finds the line moved by lines added or dropped before it", () => {
    const more = yaml.replace("metadata:\n", "metadata:\n  annotations:\n    a: b\n");
    expect(sameLine(yaml, 6, more)).toBe(8);
    expect(sameLine(more, 8, yaml)).toBe(6);
  });

  it("takes the nearest of equal lines", () => {
    const twice = ["a:", "  x: 1", "b:", "  x: 1", "c:", "  x: 1"].join("\n");
    expect(sameLine(twice, 3, "z: 0\n" + twice)).toBe(4);
  });

  it("falls back to the same line number when the text is gone", () => {
    expect(sameLine(yaml, 4, yaml.replace('resourceVersion: "1"', 'resourceVersion: "2"'))).toBe(4);
    expect(sameLine(yaml, 7, "a: 1\nb: 2")).toBe(1);
  });
});

describe("sameLine in lists", () => {
  it("keeps to the same list item", () => {
    const pod = ["spec:", "  containers:", "  - name: x", "    ports: []", "  - name: y", "    ports: []"].join("\n");
    const more = pod.replace("  - name: x\n", '  - name: x\n    env:\n    - name: A\n      value: "1"\n');
    // y's ports, not x's (the nearer line with that text)
    expect(sameLine(pod, 5, more)).toBe(8);
  });
});
