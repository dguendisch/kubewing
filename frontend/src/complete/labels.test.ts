import { describe, expect, it } from "vitest";
import { labelContext, labelValueCandidates } from "./labels";

const ctx = (s: string) => labelContext(s.replace("|", ""), s.indexOf("|"));

describe("labelContext", () => {
  it("completes a key, also negated and after a comma", () => {
    expect(ctx("|")).toEqual({ from: 0, word: "", at: "key" });
    expect(ctx("ap|")).toEqual({ from: 0, word: "ap", at: "key" });
    expect(ctx("!app.kubernetes.io/na|")).toEqual({ from: 1, word: "app.kubernetes.io/na", at: "key" });
    expect(ctx("app=api, ti|")).toEqual({ from: 9, word: "ti", at: "key" });
    expect(ctx("env in (a, b),ti|")).toEqual({ from: 14, word: "ti", at: "key" });
  });

  it("completes a value after =, == and !=", () => {
    expect(ctx("app=|")).toEqual({ from: 4, word: "", at: "value", key: "app" });
    expect(ctx("tier=x,app == et|")).toEqual({ from: 14, word: "et", at: "value", key: "app" });
    expect(ctx("app!=e|")).toEqual({ from: 5, word: "e", at: "value", key: "app" });
  });

  it("completes the operator after a key and a space, replacing the space", () => {
    expect(ctx("app |")).toEqual({ from: 3, word: "", at: "operator", key: "app" });
    expect(ctx("app  no|")).toEqual({ from: 3, word: "no", at: "operator", key: "app" });
    expect(ctx("!app |")).toBeUndefined();
  });

  it("completes the values of an in (…) list, with those already listed", () => {
    expect(ctx("env in (|")).toEqual({ from: 8, word: "", at: "value", key: "env", listed: [] });
    expect(ctx("env notin (prod, st|")).toEqual({ from: 17, word: "st", at: "value", key: "env", listed: ["prod"] });
  });

  it("has nothing after a finished requirement", () => {
    expect(ctx("app=api |")).toBeUndefined();
    expect(ctx("env in (a) |")).toBeUndefined();
  });
});

describe("labelValueCandidates", () => {
  it("skips the listed values and shows how many objects have each", () => {
    const f = { values: [{ value: "prod", count: 3 }, { value: "dev", count: 1 }], objects: 4 };
    expect(labelValueCandidates(f, ["prod"])).toEqual([{ value: "dev", label: "dev", detail: "1/4" }]);
  });
});
