import { describe, expect, it } from "vitest";
import { labelCandidates, labelContext } from "./labels";

const ctx = (s: string) => labelContext(s.replace("|", ""), s.indexOf("|"));

describe("labelContext", () => {
  it("completes a key, also negated and after a comma", () => {
    expect(ctx("|")).toEqual({ from: 0, word: "", at: "key", others: "" });
    expect(ctx("ap|")).toEqual({ from: 0, word: "ap", at: "key", others: "" });
    expect(ctx("!app.kubernetes.io/na|")).toEqual({ from: 1, word: "app.kubernetes.io/na", at: "key", others: "" });
    expect(ctx("app=api, ti|")).toEqual({ from: 9, word: "ti", at: "key", others: "app=api" });
    expect(ctx("env in (a, b),ti|")).toEqual({ from: 14, word: "ti", at: "key", others: "env in (a, b)" });
  });

  it("completes a value after =, == and !=", () => {
    expect(ctx("app=|")).toEqual({ from: 4, word: "", at: "value", key: "app", others: "" });
    expect(ctx("tier=x,app == et|")).toEqual({ from: 14, word: "et", at: "value", key: "app", others: "tier=x" });
    expect(ctx("app!=e|")).toEqual({ from: 5, word: "e", at: "value", key: "app", others: "" });
  });

  it("completes the operator after a key and a space, replacing the space", () => {
    expect(ctx("app |")).toEqual({ from: 3, word: "", at: "operator", key: "app", others: "" });
    expect(ctx("app  no|")).toEqual({ from: 3, word: "no", at: "operator", key: "app", others: "" });
    expect(ctx("!app |")).toBeUndefined();
  });

  it("completes the values of an in (…) list, with those already listed", () => {
    expect(ctx("env in (|")).toEqual({ from: 8, word: "", at: "value", key: "env", listed: [], others: "" });
    expect(ctx("env notin (prod, st|")).toEqual({ from: 17, word: "st", at: "value", key: "env", listed: ["prod"], others: "" });
  });

  it("leaves out the requirement being completed, also its rest after the caret", () => {
    expect(ctx("app=we|b, tier=x")).toMatchObject({ at: "value", key: "app", word: "we", others: "tier=x" });
    expect(ctx("tier in (a, b), app=|web ,env!=dev")).toMatchObject({ at: "value", key: "app", others: "tier in (a, b),env!=dev" });
    expect(ctx("app=web,|")).toMatchObject({ at: "key", others: "app=web" });
    expect(ctx("env in (a, |b), app=web")).toMatchObject({ at: "value", key: "env", listed: ["a"], others: "app=web" });
  });

  it("has nothing after a finished requirement", () => {
    expect(ctx("app=api |")).toBeUndefined();
    expect(ctx("env in (a) |")).toBeUndefined();
  });
});

describe("labelCandidates", () => {
  it("skips the listed values and shows how many objects have each", () => {
    const f = { items: [{ value: "prod", count: 3 }, { value: "dev", count: 1 }], objects: 4 };
    expect(labelCandidates(f, ["prod"])).toEqual([{ value: "dev", label: "dev", detail: "1/4" }]);
  });
});
