import { describe, expect, it } from "vitest";
import { fontStack, gridHeights, parseFamilies, unligate, zoomedSize, zoomStep } from "./font";

const defaults = '"SF Mono", ui-monospace, Menlo, monospace';

describe("fontStack", () => {
  it("is the default stack without a family", () => {
    expect(fontStack(undefined, defaults)).toBe(defaults);
    expect(fontStack("  ", defaults)).toBe(defaults);
  });
  it("quotes a configured family (names with spaces) in front of the defaults", () => {
    expect(fontStack("JetBrainsMono Nerd Font", defaults)).toBe(`"JetBrainsMono Nerd Font", ${defaults}`);
  });
  it("takes a list, quoted or not, and leaves generic families unquoted", () => {
    expect(fontStack(`'Fira Code', Monaco, monospace`, defaults)).toBe(`"Fira Code", "Monaco", monospace, ${defaults}`);
    expect(parseFamilies(`"ui-monospace"`)).toEqual([{ name: "ui-monospace", generic: false }]);
  });
});

describe("unligate", () => {
  it("breaks runs of ASCII symbols with a zero-width non-joiner", () => {
    expect(unligate("a -> b != c")).toBe("a -‌> b !‌= c");
    expect(unligate("===")).toBe("=‌=‌=");
    expect(unligate("http://x")).toBe("http:‌/‌/x");
  });
  it("leaves letters, digits, spaces and single symbols alone", () => {
    expect(unligate("web-1 10.0.0.1 ok")).toBe("web-1 10.0.0.1 ok");
    expect(unligate("fi ffl")).toBe("fi ffl");
  });
});

describe("gridHeights", () => {
  it("is 22/24 at the default size and follows the size", () => {
    expect(gridHeights(12)).toEqual({ row: 22, header: 24 });
    expect(gridHeights(16)).toEqual({ row: 26, header: 28 });
  });
});

describe("zoom", () => {
  it("steps one px at a time and ⌘0 drops the offset", () => {
    expect(zoomStep(12, 0, 1)).toBe(1);
    expect(zoomStep(12, 1, 1)).toBe(2);
    expect(zoomStep(12, 2, -1)).toBe(1);
    expect(zoomStep(12, -3, 0)).toBe(0);
    expect(zoomedSize(12, 2)).toBe(14);
  });
  it("stays within 8 … 24 px, and one step back from a bound is one px back", () => {
    expect(zoomStep(23, 1, 1)).toBe(1);
    expect(zoomStep(9, -1, -1)).toBe(-1);
    // a reload brought font.size nearer the bound than the offset reaches: the size shown is the limit
    expect(zoomedSize(22, 5)).toBe(24);
    expect(zoomStep(22, 5, -1)).toBe(1);
    expect(zoomedSize(10, -5)).toBe(8);
    expect(zoomStep(10, -5, 1)).toBe(-1);
  });
});
