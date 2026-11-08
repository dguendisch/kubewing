import { describe, expect, it } from "vitest";
import { changedRange } from "./changed";

describe("changedRange", () => {
  it("is the lines that differ, with the new text for them", () => {
    expect(changedRange("a\nb\nc\n", "a\nB\nc\n")).toEqual({ from: 1, to: 1, text: "B" });
    expect(changedRange("a\nb\nc", "a\nb1\nb2\nc")).toEqual({ from: 1, to: 1, text: "b1\nb2" });
    expect(changedRange("x", "y")).toEqual({ from: 0, to: 0, text: "y" });
  });

  it("applied, gives the new text", () => {
    for (const [a, b] of [
      ["a\nb\nc\n", "a\nB\nc\n"],
      ["a\nb\nc", "a\nc"],
      ["k: v\n", "k: |\n  x\n  y\n"],
      ["same\n", "same\nmore\n"],
    ] as const) {
      const r = changedRange(a, b);
      const l = a.split("\n");
      expect([...l.slice(0, r.from), r.text, ...l.slice(r.to + 1)].join("\n")).toBe(b);
    }
  });
});
