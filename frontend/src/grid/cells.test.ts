import { describe, expect, it } from "vitest";
import { formatAge, layout, withAlpha } from "./cells";

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

/** Glide 6.0.3 parseToRgba's string handling, applied to a computed color. */
const glideParse = (computed: string) => computed.replace(/[^\d.,]/g, "").split(",").map(Number.parseFloat);

describe("withAlpha", () => {
  it("produces colors Glide's blend() can parse (regression: selection on ⌥↑/⌥↓)", () => {
    // Chromium computes our output unchanged (checked in the browser), so Glide sees 4 channels
    expect(glideParse(withAlpha("#6ea8ff", 0.18))).toEqual([110, 168, 255, 0.18]);
    // what Chromium computes for the old color-mix() value: Glide gets 1 number → NaN blend
    expect(glideParse("color(srgb 0.431373 0.658824 1 / 0.18)")).toHaveLength(1);
  });
  // Glide parses canvas colors as rgba(r, g, b, a) only (see withAlpha)
  it("emits plain rgba() from hex and rgb tokens", () => {
    expect(withAlpha("#6ea8ff", 0.18)).toBe("rgba(110, 168, 255, 0.18)");
    expect(withAlpha(" #fff ", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
    expect(withAlpha("rgb(1, 2, 3)", 1)).toBe("rgba(1, 2, 3, 1)");
    expect(withAlpha("rgb(1 2 3)", 0.2)).toBe("rgba(1, 2, 3, 0.2)");
  });
  it("rejects formats Glide would mis-blend instead of silently rendering garbage", () => {
    expect(() => withAlpha("color-mix(in srgb, red 18%, transparent)", 1)).toThrow(/unsupported/);
    expect(() => withAlpha("oklch(0.7 0.1 250)", 1)).toThrow(/unsupported/);
  });
});
