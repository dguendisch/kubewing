import { expect, it } from "vitest";
import { lineDiff } from "./diff";

it("diffs lines", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
    { op: " ", text: "a" },
    { op: "-", text: "b" },
    { op: "+", text: "B" },
    { op: " ", text: "c" },
  ]);
});
