import { describe, expect, it } from "vitest";
import { yamlFoldingRanges } from "./yamlFolding";

const fold = (yaml: string) => yamlFoldingRanges(yaml.split("\n"));

describe("yamlFoldingRanges", () => {
  it("folds a key over a list at its own column (sticky scroll keeps it)", () => {
    const y = [
      "spec:", //               1
      "  containers:", //       2
      "  - args:", //           3
      "    - --endpoint=x", //  4
      "    - --v=2", //         5
      "    image: csi", //      6
      "  - name: b", //         7
      "    image: b", //        8
      "  dnsPolicy: Default", // 9
      "status: {}", //         10
    ].join("\n");
    expect(fold(y)).toEqual([
      { start: 1, end: 9 },
      { start: 2, end: 8 },
      { start: 3, end: 6 },
      { start: 7, end: 8 },
    ]);
  });

  it("folds nested maps and indented lists", () => {
    const y = ["metadata:", "  labels:", "    a: b", "  finalizers:", "    - x", "    - y", "kind: Pod"].join("\n");
    expect(fold(y)).toEqual([
      { start: 1, end: 6 },
      { start: 2, end: 3 },
      { start: 4, end: 6 },
    ]);
  });

  it("doesn't fold keys with values, empty keys or one-line items", () => {
    expect(fold(["a: 1", "b:", "c: {}", "d:", "- x", "- y"].join("\n"))).toEqual([{ start: 4, end: 6 }]);
  });

  it("folds block scalars as text, even lines that look like YAML", () => {
    const y = ["data:", "  script: |", "    a:", "      - b", "  other: x", "  run: >-", "    c: d"].join("\n");
    expect(fold(y)).toEqual([
      { start: 1, end: 7 },
      { start: 2, end: 4 },
      { start: 6, end: 7 },
    ]);
  });

  it("folds a block scalar list item", () => {
    expect(fold(["args:", "- |", "  x: y", "- z"].join("\n"))).toEqual([
      { start: 1, end: 4 },
      { start: 2, end: 3 },
    ]);
  });

  it("ignores comments and blank lines, also trailing ones", () => {
    const y = ["a:", "  # note", "", "  b: 1", "", "# end", "c: 2"].join("\n");
    expect(fold(y)).toEqual([{ start: 1, end: 4 }]);
  });

  it("handles nested dashes and quoted keys", () => {
    const y = ['"x:y":', "- - a", "  - b", "- c"].join("\n");
    expect(fold(y)).toEqual([
      { start: 1, end: 4 },
      { start: 2, end: 3 },
    ]);
  });
});
