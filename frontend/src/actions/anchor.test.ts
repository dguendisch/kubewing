import { describe, expect, it } from "vitest";
import { placeMenu, type Box } from "./anchor";

const win = { width: 1400, height: 800 };
const menu = { width: 320, height: 200 };
const viewport: Box = { x: 10, y: 50, width: 700, height: 700 };
const row = (y: number): Box => ({ x: 10, y, width: 700, height: 22 });

describe("placeMenu", () => {
  it("drops down from the row, flush left", () => {
    expect(placeMenu({ kind: "row", row: row(100), viewport }, menu, win)).toEqual({ x: 10, y: 122, above: false });
  });
  it("flips above the row near the window bottom", () => {
    expect(placeMenu({ kind: "row", row: row(700), viewport }, menu, win)).toEqual({ x: 10, y: 500, above: true });
  });
  it("neither side fits: the side with more room", () => {
    const small = { width: 1400, height: 320 };
    expect(placeMenu({ kind: "row", row: row(250), viewport }, { width: 320, height: 260 }, small).above).toBe(true); // 246 above vs 44 below
    expect(placeMenu({ kind: "row", row: row(60), viewport }, { width: 320, height: 260 }, small).above).toBe(false); // 56 above vs 234 below
  });
  it("a row scrolled out of view anchors to the pane's edge", () => {
    expect(placeMenu({ kind: "row", row: row(-300), viewport }, menu, win).y).toBe(50); // above the top: at the top edge
    expect(placeMenu({ kind: "row", row: row(2000), viewport }, menu, win)).toMatchObject({ y: 550, above: true }); // below: above the bottom edge
  });
  it("stays inside the window horizontally", () => {
    const r: Box = { x: 1300, y: 100, width: 90, height: 22 };
    expect(placeMenu({ kind: "row", row: r, viewport: { ...viewport, x: 1290, width: 100 } }, menu, win).x).toBe(1400 - 320 - 4);
  });
  it("pointer: at the point, flipped left/up at the window edges", () => {
    expect(placeMenu({ kind: "point", x: 200, y: 100 }, menu, win)).toEqual({ x: 200, y: 100, above: false });
    expect(placeMenu({ kind: "point", x: 1300, y: 700 }, menu, win)).toEqual({ x: 980, y: 500, above: true });
  });
  it("a menu taller than the space on either side is clamped into the window", () => {
    const tall = { width: 320, height: 790 };
    const p = placeMenu({ kind: "row", row: row(400), viewport }, tall, win);
    expect(p.y).toBeGreaterThanOrEqual(4);
    expect(p.y + tall.height).toBeLessThanOrEqual(800 - 4);
    // taller than the window: the top stays visible
    expect(placeMenu({ kind: "row", row: row(400), viewport }, { width: 320, height: 900 }, win).y).toBe(4);
  });
});
