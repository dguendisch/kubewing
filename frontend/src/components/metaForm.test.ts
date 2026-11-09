import { describe, expect, it } from "vitest";
import { hasChanges, parseMeta, parseReplicas, recentCandidates, tokenAt, unionCurrent, unionMeta } from "./metaForm";

describe("label / annotate text", () => {
  const cur = { app: "web", tier: "front" };

  it("sets, changes and removes as kubectl does", () => {
    const r = parseMeta("env=prod tier=back\napp-", cur);
    expect(r).toEqual({
      changes: [
        { key: "env", value: "prod", op: "add", old: undefined },
        { key: "tier", value: "back", op: "change", old: "front" },
        { key: "app", op: "remove", old: "web" },
      ],
      send: { set: { env: "prod", tier: "back" }, remove: ["app"] },
    });
  });

  it("a key set to its value is no change", () => {
    const r = parseMeta("app=web", cur);
    if (!("send" in r)) throw new Error(r.error);
    expect(r.changes[0]!.op).toBe("same");
    expect(hasChanges(r.send)).toBe(false);
    expect(parseMeta("  ", cur)).toEqual({ changes: [], send: { set: {}, remove: [] } });
  });

  it("quotes keep spaces; = in a value and empty values are fine", () => {
    expect(parseMeta(`note="drained, back at 14:00" url=a=b flag=`)).toMatchObject({
      send: { set: { note: "drained, back at 14:00", url: "a=b", flag: "" }, remove: [] },
    });
  });

  it("says what's wrong", () => {
    expect(parseMeta("app", cur)).toEqual({ error: `"app": key=value sets, key- removes` });
    expect(parseMeta("gone-", cur)).toEqual({ error: `"gone" isn't set` });
    expect(parseMeta("=x", cur)).toEqual({ error: `"=x": the key is missing` });
    expect(parseMeta("a=1 a=2", cur)).toEqual({ error: `"a" is given twice` });
    expect(parseMeta(`a="open`, cur)).toEqual({ error: "unterminated \"" });
  });
});

describe("replicas", () => {
  it("takes whole numbers from 0", () => {
    expect(parseReplicas(" 0 ")).toEqual({ replicas: 0 });
    expect(parseReplicas("12")).toEqual({ replicas: 12 });
    expect(parseReplicas("-1")).toEqual({ error: `"-1" isn't a number of replicas (0 or more)` });
    expect(parseReplicas("1.5")).toHaveProperty("error");
    expect(parseReplicas("")).toEqual({ error: "how many replicas?" });
  });
});

describe("label / annotate on many rows", () => {
  const keys = unionMeta([{ app: "web", tier: "front" }, { app: "web", tier: "back" }, { app: "web" }]);

  it("counts keys and their values", () => {
    expect(keys).toEqual([
      { key: "app", count: 3, values: [{ value: "web", count: 3 }] },
      { key: "tier", count: 2, values: [{ value: "back", count: 1 }, { value: "front", count: 1 }] },
    ]);
  });

  it("a key the same on every row compares as one; a mixed one can be set or removed", () => {
    const cur = unionCurrent(keys, 3);
    const r = parseMeta("app=web tier=front", cur);
    expect("changes" in r && r.changes.map((c) => c.op)).toEqual(["same", "change"]);
    expect("send" in r && r.send).toEqual({ set: { tier: "front" }, remove: [] });
    expect(parseMeta("tier-", cur)).toMatchObject({ send: { remove: ["tier"] } });
    expect(parseMeta("env-", cur)).toEqual({ error: '"env" isn\'t set' });
  });
});

describe("recent labels / annotations", () => {
  it("finds the token at the caret, quotes included", () => {
    expect(tokenAt("", 0)).toEqual({ from: 0, to: 0, word: "" });
    expect(tokenAt("env=prod ti", 11)).toEqual({ from: 9, to: 11, word: "ti" });
    expect(tokenAt("env=prod tier=x", 10)).toEqual({ from: 9, to: 15, word: "t" });
    expect(tokenAt("env=prod  x", 9)).toEqual({ from: 9, to: 9, word: "" });
    expect(tokenAt(`note="two words" a`, 9)).toEqual({ from: 0, to: 16, word: `note="two` });
    expect(tokenAt(`note="open`, 10)).toEqual({ from: 0, to: 10, word: `note="open` });
  });

  it("offers recent pairs quoted, without keys given elsewhere, compared with the current values", () => {
    const recent = ["env=prod", "note=two words", "tier=back", "app=web", "bad"];
    const text = "tier- e";
    const c = recentCandidates(recent, text, tokenAt(text, 7), { app: "web", env: "dev" });
    expect(c).toEqual([
      { value: "env=prod", label: "env=prod", detail: "now dev", removable: true },
      { value: `note="two words"`, label: "note=two words", detail: undefined, removable: true },
      { value: "app=web", label: "app=web", detail: "already set", removable: true },
    ]);
    // the token being replaced doesn't hide its own key
    expect(recentCandidates(["env=prod"], "env=d", { from: 0, to: 5 }).map((x) => x.value)).toEqual(["env=prod"]);
    expect(recentCandidates(["env=prod"], "", { from: 0, to: 0 }, { env: "\u0000mixed" })[0]!.detail).toBe("now differs");
  });
});
