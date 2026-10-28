import { describe, expect, it } from "vitest";
import { applyFrame, emptyPane, nowOf, rowAt } from "./rowcache";

const cols = [{ name: "NAME" }];

describe("applyFrame", () => {
  it("applies initial frame and deltas", () => {
    let p = applyFrame(emptyPane(), {
      seq: 1, columns: cols, total: 2, offset: 0, order: ["a", "b"],
      rows: [{ key: "a", cells: ["a"] }, { key: "b", cells: ["b"] }],
      status: { synced: true, objects: 2 },
    });
    expect(rowAt(p, 1)?.cells).toEqual(["b"]);
    p = applyFrame(p, { seq: 2, total: 2, offset: 0, order: ["b", "a"], rows: [{ key: "a", cells: ["a2"], changed: [0] }] });
    expect(rowAt(p, 0)?.key).toBe("b");
    expect(rowAt(p, 1)?.cells).toEqual(["a2"]);
    expect(p.status.synced).toBe(true); // status carried over
  });

  it("drops rows leaving the window and ignores stale frames", () => {
    let p = applyFrame(emptyPane(), {
      seq: 5, columns: cols, total: 3, offset: 0, order: ["a", "b"],
      rows: [{ key: "a", cells: ["a"] }, { key: "b", cells: ["b"] }],
    });
    p = applyFrame(p, { seq: 6, total: 3, offset: 1, order: ["b", "c"], rows: [{ key: "c", cells: ["c"] }] });
    expect([...p.rows.keys()].sort()).toEqual(["b", "c"]);
    expect(rowAt(p, 0)).toBeUndefined();
    expect(rowAt(p, 2)?.key).toBe("c");
    expect(applyFrame(p, { seq: 4, total: 0, offset: 0, order: [] })).toBe(p);
  });

  it("columns reset the cache", () => {
    let p = applyFrame(emptyPane(), { seq: 1, columns: cols, total: 1, offset: 0, order: ["a"], rows: [{ key: "a", cells: ["a"] }] });
    p = applyFrame(p, { seq: 2, columns: [{ name: "X" }], total: 1, offset: 0, order: ["a"], rows: [{ key: "a", cells: ["x"] }] });
    expect(rowAt(p, 0)?.cells).toEqual(["x"]);
    expect(p.columns[0]?.name).toBe("X");
  });

  it("ages count from the moment shown while in the past", () => {
    const at = "2026-01-01T12:00:00Z";
    const past = applyFrame(emptyPane(), { seq: 1, total: 0, offset: 0, order: [], status: { synced: true, objects: 0, at } });
    expect(nowOf(past)).toBe(Date.parse(at));
    const live = applyFrame(past, { seq: 2, total: 0, offset: 0, order: [], status: { synced: true, objects: 0 } });
    expect(Math.abs(nowOf(live) - Date.now())).toBeLessThan(1000);
  });
});
