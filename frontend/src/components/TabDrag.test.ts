import { describe, expect, it } from "vitest";
import { dropIndex } from "./TabDrag";

// two rows: tabs 0–2 on top (y 0–20), 3–4 below (y 21–41); each 100px wide from x 0
const box = (col: number, row: number) => ({ left: col * 100, right: col * 100 + 100, top: row * 21, bottom: row * 21 + 20 });
const boxes = [box(0, 0), box(1, 0), box(2, 0), box(0, 1), box(1, 1)];

describe("dropIndex", () => {
  it("one row: before the first tab whose middle is right of the pointer, else last", () => {
    const row = boxes.slice(0, 3);
    expect(dropIndex(row, 10, 10)).toBe(0);
    expect(dropIndex(row, 160, 10)).toBe(2);
    expect(dropIndex(row, 900, 10)).toBe(3);
    expect(dropIndex([], 10, 10)).toBe(0);
  });

  it("wrapped rows: the row the pointer is in decides", () => {
    expect(dropIndex(boxes, 10, 30)).toBe(3); // start of the second row
    expect(dropIndex(boxes, 160, 30)).toBe(5); // past the second row's last middle: last
    expect(dropIndex(boxes, 900, 10)).toBe(3); // right of the first row: its end, not the bar's
  });

  it("above or below the bar: the nearest row", () => {
    expect(dropIndex(boxes, 160, -50)).toBe(2);
    expect(dropIndex(boxes, 10, 500)).toBe(3);
  });
});
