import { describe, expect, it } from "vitest";
import { formatAge, layout } from "./cells";

const now = Date.parse("2026-01-01T12:00:00Z");

describe("formatAge", () => {
  it("matches kubectl style", () => {
    expect(formatAge("2026-01-01T11:59:55Z", now)).toBe("5s");
    expect(formatAge("2026-01-01T11:58:30Z", now)).toBe("1m30s");
    expect(formatAge("2026-01-01T09:00:00Z", now)).toBe("3h");
    expect(formatAge("2025-12-30T10:00:00Z", now)).toBe("2d2h");
    expect(formatAge("2025-11-01T12:00:00Z", now)).toBe("61d");
  });
});

describe("layout", () => {
  const cols = [{ name: "NAME" }, { name: "RESTARTS", type: "number" as const }, { name: "AGE", type: "age" as const }];
  const row = { key: "k", cells: ["a", "3", "2026-01-01T11:00:00Z"] };
  it("plain cells", () => {
    expect(layout(row, 1, cols[1], now)).toMatchObject({ text: "3", color: "fg", align: "right" });
    expect(layout(row, 2, cols[2], now)).toMatchObject({ text: "1h", color: "fgMuted" });
  });
  it("diff markers", () => {
    expect(layout({ ...row, changed: [1] }, 1, cols[1], now)).toMatchObject({ tint: "changed", color: "changed" });
    expect(layout({ ...row, changed: [1] }, 0, cols[0], now).tint).toBeUndefined();
    expect(layout({ ...row, mark: "deleted" }, 0, cols[0], now)).toMatchObject({ strike: true, tint: "deleted" });
    expect(layout({ ...row, mark: "added" }, 2, cols[2], now)).toMatchObject({ tint: "added" });
    expect(layout({ ...row, hidden: true }, 0, cols[0], now).hiddenMarker).toBe(true);
    expect(layout({ ...row, hidden: true }, 1, cols[1], now).hiddenMarker).toBe(false);
  });
  it("missing rows render empty", () => {
    expect(layout(undefined, 0, cols[0], now).text).toBe("");
  });
});
