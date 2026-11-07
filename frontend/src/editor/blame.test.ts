import { describe, expect, it } from "vitest";
import { age, blameColumn, blameLabel, blameMaxChars, blameTitle } from "./blame";

const now = Date.parse("2026-01-05T10:00:00Z");

describe("blame", () => {
  it("ages read like kubectl's AGE column", () => {
    expect(age("2026-01-05T09:59:15Z", now)).toBe("45s");
    expect(age("2026-01-05T09:48:00Z", now)).toBe("12m");
    expect(age("2026-01-05T05:00:00Z", now)).toBe("5h");
    expect(age("2026-01-02T10:00:00Z", now)).toBe("3d");
    expect(age("2023-12-01T10:00:00Z", now)).toBe("2y");
  });

  it("a label names the newest owner, how long ago, and how many others", () => {
    expect(blameLabel([{ manager: "autoscaler", operation: "Update", subresource: "scale", time: "2026-01-03T10:00:00Z" }], now)).toBe("autoscaler 2d");
    expect(
      blameLabel(
        [
          { manager: "kubewing", operation: "Update", time: "2026-01-05T09:59:00Z" },
          { manager: "kubectl", operation: "Apply", time: "2026-01-01T10:00:00Z" },
        ],
        now,
      ),
    ).toBe("kubewing +1 60s");
    expect(blameLabel([{ manager: "helm", operation: "Update" }], now)).toBe("helm");
  });

  it("a long manager name is cut to fit, the age kept", () => {
    const l = blameLabel([{ manager: "gardener-resource-manager-shoot-controller", operation: "Apply", time: "2026-01-02T10:00:00Z" }], now);
    expect(l.length).toBe(blameMaxChars);
    expect(l.endsWith("… 3d")).toBe(true);
  });

  it("the tooltip lists every owner with operation, subresource and time", () => {
    expect(
      blameTitle(
        [
          { manager: "hpa", operation: "Update", subresource: "scale", time: "2026-01-04T10:00:00Z" },
          { manager: "kubectl", operation: "Apply" },
        ],
        now,
      ),
    ).toBe("hpa (Update, scale) · 2026-01-04T10:00:00Z · 24h ago\nkubectl (Apply)");
  });

  it("the column has a label per blamed line (1-based) and fits the longest", () => {
    const c = blameColumn({ lines: [{ line: 3, owners: [{ manager: "kube-controller-manager", operation: "Update", time: "2026-01-04T10:00:00Z" }] }] }, now);
    expect(c.labels.get(4)).toBe("kube-controller-manager 24h");
    expect(c.labels.get(3)).toBeUndefined();
    expect(c.width).toBe("kube-controller-manager 24h".length + 2);
    expect(blameColumn({ lines: [] }, now).width).toBe(10);
  });
});
