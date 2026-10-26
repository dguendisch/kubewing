import { describe, expect, it } from "vitest";
import type { Timeline } from "../transport/types";
import { ago, at, position, shifted, size } from "./travel";

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString();
const tl: Timeline = { horizon: t(0), newest: t(100), at: t(50), changes: [t(10), t(50), t(90)], bytes: 0, budget: 0 };

describe("time-travel moments", () => {
  it("shifts within the span; past the newest is live", () => {
    expect(shifted(tl, -20_000)).toBe(t(30));
    expect(shifted(tl, -999_000)).toBe(t(0));
    expect(shifted(tl, 40_000)).toBe(t(90));
    expect(shifted(tl, 60_000)).toBeUndefined();
    // from live: from the newest
    expect(shifted({ ...tl, at: undefined }, -60_000)).toBe(t(40));
  });

  it("places times on the bar and back, snapping to a near change", () => {
    expect(position(tl, t(25))).toBe(0.25);
    expect(position(tl, t(-5))).toBe(0);
    expect(position({ ...tl, newest: t(0) }, t(0))).toBe(1);
    expect(at(tl, 0.105)).toBe(t(10));
    expect(at(tl, 0.3)).toBe(t(30));
    expect(at(tl, 2)).toBe(t(100));
  });

  it("sizes in binary units", () => {
    expect(size(512)).toBe("512 B");
    expect(size(3.4 * 1024 * 1024)).toBe("3.4 MiB");
    expect(size(512 * 1024 * 1024)).toBe("512 MiB");
    expect(size(820 * 1024)).toBe("820 KiB");
  });

  it("says how long ago", () => {
    const now = Date.parse(t(0)) + 250_000;
    expect(ago(t(0), now)).toBe("4m 10s ago");
    expect(ago(t(245), now)).toBe("5s ago");
  });
});
