import { describe, expect, it } from "vitest";
import { changeIndex } from "./diffnav";

describe("changeIndex", () => {
  const starts = [5, 12, 30];
  it("is the change the cursor is on or after, 0 before the first", () => {
    expect(changeIndex(starts, 1)).toBe(0);
    expect(changeIndex(starts, 5)).toBe(1);
    expect(changeIndex(starts, 11)).toBe(1);
    expect(changeIndex(starts, 12)).toBe(2);
    expect(changeIndex(starts, 99)).toBe(3);
    expect(changeIndex([], 3)).toBe(0);
  });
});
