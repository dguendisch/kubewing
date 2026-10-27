import { describe, expect, it } from "vitest";
import { checkLogForm, initialLogForm, parseHistory, toggleAllContainers, toggleContainer } from "./options";

describe("log dialog form", () => {
  it("defaults to every container, the configured tail, following", () => {
    const f = initialLogForm(["app", "side"], 100);
    expect(f).toEqual({ containers: ["app", "side"], picked: ["app", "side"], history: "100", follow: true, timestamps: false });
    // all checked: no names sent, so a later pod's containers are followed too
    expect(checkLogForm(f)).toEqual({ tail: 100, containers: undefined, follow: true });
  });

  it("parses the history field: lines, a duration, or all", () => {
    expect(parseHistory("500")).toEqual({ tail: 500 });
    expect(parseHistory(" 10m ")).toEqual({ since: "10m" });
    expect(parseHistory("1h30m")).toEqual({ since: "1h30m" });
    expect(parseHistory("1.5h")).toEqual({ since: "1.5h" });
    expect(parseHistory("All")).toEqual({ all: true });
    expect(parseHistory("0")).toBe("the number of lines must be at least 1");
    expect(parseHistory("0m")).toMatch(/duration/);
    expect(parseHistory("10 minutes")).toMatch(/duration/);
    expect(parseHistory("")).toMatch(/duration/);
  });

  it("toggles containers, keeping their order", () => {
    let f = initialLogForm(["app", "side", "init"], 100);
    f = toggleContainer(f, "side");
    expect(f.picked).toEqual(["app", "init"]);
    expect(checkLogForm({ ...f, follow: false })).toEqual({ tail: 100, containers: ["app", "init"], follow: false });
    f = toggleContainer(f, "side");
    expect(f.picked).toEqual(["app", "side", "init"]);
    f = toggleAllContainers(f);
    expect(f.picked).toEqual([]);
    expect(checkLogForm(f)).toBe("pick at least one container");
    expect(toggleAllContainers(f).picked).toEqual(["app", "side", "init"]);
  });

  it("no containers known yet (no pods): nothing to pick, the tail still starts", () => {
    expect(checkLogForm(initialLogForm([], 100))).toEqual({ tail: 100, containers: undefined, follow: true });
  });
});
