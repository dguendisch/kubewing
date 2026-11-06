import { describe, expect, it } from "vitest";
import { cellChoices, formatAge, initialCell, layout, toHex, withAlpha } from "./cells";

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
  it("a pod's restarts: the count and how long ago the last restart was, right-aligned", () => {
    const c = { name: "RESTARTS", type: "restarts" as const };
    expect(layout({ key: "k", cells: ["3 (2026-01-01T11:55:00Z)"] }, 0, c, now)).toMatchObject({ text: "3 (5m ago)", align: "right" });
    expect(layout({ key: "k", cells: ["0"] }, 0, c, now).text).toBe("0");
    expect(layout({ key: "k", cells: ["1 (5m ago)"] }, 0, c, now).text).toBe("1 (5m ago)"); // the server's text
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

describe("toHex", () => {
  it("passes hex through, converts rgb(), blends alpha over a background", () => {
    expect(toHex("#6ea8ff")).toBe("#6ea8ff");
    expect(toHex("#abc")).toBe("#aabbcc");
    expect(toHex("rgb(203, 75, 22)")).toBe("#cb4b16");
    expect(toHex("#ffffff", 0.5, "#000000")).toBe("#808080");
    expect(toHex("#6ea8ff", 0.25, "#101418")).toBe("#283952");
  });
  it("refuses colors xterm can't take", () => {
    expect(() => toHex("oklch(70% 0.1 250)")).toThrow(/toHex: unsupported color/);
  });
});

describe("cellChoices", () => {
  const cols = [{ name: "NAME" }, { name: "NOMINATED NODE" }, { name: "RESTARTS", type: "number" as const }, { name: "AGE", type: "age" as const }];
  const row = { key: "k", cells: ["web-0", "", "3", "2026-01-01T11:00:00Z"] };

  it("lists every column with its value, then the whole row tab-separated", () => {
    expect(cellChoices(row, cols, now)).toEqual([
      { label: "NAME", text: "web-0", shown: undefined, disabled: undefined },
      { label: "NOMINATED NODE", text: "", shown: undefined, disabled: "empty" },
      { label: "RESTARTS", text: "3", shown: undefined, disabled: undefined },
      // the timestamp is copied (a "1h" goes stale once pasted); the picker shows both
      { label: "AGE", text: "2026-01-01T11:00:00Z", shown: "1h", disabled: undefined },
      { label: "whole row", text: "web-0\t\t3\t2026-01-01T11:00:00Z", shown: "tab-separated" },
    ]);
  });

  it("a single column has no whole-row entry", () => {
    expect(cellChoices({ key: "k", cells: ["a"] }, [{ name: "NAME" }], now).map((c) => c.label)).toEqual(["NAME"]);
  });

  it("highlights the given column if it can be copied, else the first that can", () => {
    const c = cellChoices(row, cols, now);
    expect(initialCell(c, "RESTARTS")).toBe(2);
    expect(initialCell(c, "NOMINATED NODE")).toBe(0); // empty
    expect(initialCell(c, "GONE")).toBe(0);
    expect(initialCell(c)).toBe(0);
    expect(initialCell(cellChoices({ key: "k", cells: ["", "x"] }, cols.slice(0, 2), now))).toBe(1);
  });
});
