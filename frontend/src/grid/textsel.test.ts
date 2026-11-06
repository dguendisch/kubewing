import { describe, expect, it } from "vitest";
import { boundaryAt, charAt, current, selectIn, selectedText, shownRange, textStart, wordAt } from "./textsel";

// monospace stand-in: every char 10px wide
const measure = (s: string) => s.length * 10;
const now = Date.parse("2026-01-01T12:00:00Z");

describe("wordAt", () => {
  it("keeps names, IPs, images, label pairs and paths whole", () => {
    const w = (t: string, i: number) => {
      const r = wordAt(t, i);
      return r && t.slice(...r);
    };
    expect(w("web-7d9f-abc", 5)).toBe("web-7d9f-abc");
    expect(w("10.0.0.1:8080", 3)).toBe("10.0.0.1:8080");
    expect(w("eu.gcr.io/gardener/etcd:v3.5", 12)).toBe("eu.gcr.io/gardener/etcd:v3.5");
    expect(w("app=web,tier=db", 9)).toBe("tier=db");
    expect(w("Init:0/1 (3 restarts)", 10)).toBe("3");
    expect(w("a b", 1)).toBeUndefined(); // on a space
    expect(w("ab", 2)).toBeUndefined(); // past the end
  });
});

describe("charAt / boundaryAt", () => {
  it("map x to the char under it, and to the nearest boundary", () => {
    expect(charAt("abcd", 0, measure)).toBe(0);
    expect(charAt("abcd", 15, measure)).toBe(1);
    expect(charAt("abcd", 999, measure)).toBe(3); // clamped: the padding after the text hits the last char
    expect(charAt("abcd", -5, measure)).toBe(0);
    expect(boundaryAt("abcd", 14, measure)).toBe(1);
    expect(boundaryAt("abcd", 16, measure)).toBe(2);
    expect(boundaryAt("abcd", 999, measure)).toBe(4);
    expect(boundaryAt("abcd", -50, measure)).toBe(0);
  });

  it("text starts at the padding, or right-aligned for numbers", () => {
    expect(textStart({ x: 100, width: 120 }, 30, "left", 8)).toBe(108);
    expect(textStart({ x: 100, width: 120 }, 30, "right", 8)).toBe(182);
  });
});

describe("selection", () => {
  const cols = [{ name: "NAME" }, { name: "NODE" }, { name: "AGE", type: "age" as const }];
  const row = { key: "u1", cells: ["web-0", "", "2026-01-01T11:00:00Z"] };

  it("copies the selected part; an age cell its timestamp, highlighted over what it shows", () => {
    const part = selectIn(row, cols, 0, [1, 3])!;
    expect(selectedText(part, row, cols)).toBe("eb");
    expect(selectedText(selectIn(row, cols, 0, "all"), row, cols)).toBe("web-0");
    const age = selectIn(row, cols, 2, [0, 1])!; // any selection in it takes the whole cell
    expect(age).toMatchObject({ clock: cols[2], column: "AGE" });
    expect(selectedText(age, row, cols)).toBe("2026-01-01T11:00:00Z");
    expect(shownRange(age, now)).toEqual([0, 2]); // "1h"
    expect(shownRange(part, now)).toEqual([1, 3]);
    const rc = [{ name: "RESTARTS", type: "restarts" as const }];
    const restarts = selectIn({ key: "u1", cells: ["3 (2026-01-01T11:00:00Z)"] }, rc, 0, [0, 1])!;
    expect(shownRange(restarts, now)).toEqual([0, 10]); // "3 (1h ago)"
  });

  it("nothing to select in an empty cell or an empty range", () => {
    expect(selectIn(row, cols, 1, "all")).toBeUndefined();
    expect(selectIn(row, cols, 0, [2, 2])).toBeUndefined();
  });

  it("goes stale with the cell: another row, a changed text, a removed column", () => {
    const sel = selectIn(row, cols, 0, "all")!;
    expect(current(sel, row, cols)).toBe(0);
    expect(current(sel, { ...row, key: "u2" }, cols)).toBeUndefined();
    expect(selectedText(sel, { ...row, cells: ["web-1", "", ""] }, cols)).toBeUndefined();
    expect(current(sel, row, cols.slice(1))).toBeUndefined();
    // a column moved: still the same cell
    expect(current(sel, { ...row, cells: ["", "web-0"] }, [{ name: "NODE" }, { name: "NAME" }])).toBe(1);
  });
});
