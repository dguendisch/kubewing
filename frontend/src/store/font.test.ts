import { describe, expect, it } from "vitest";
import { fontStack, gridHeights, parseFamilies, unligate } from "./font";

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
