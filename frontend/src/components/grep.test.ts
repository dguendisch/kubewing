import { describe, expect, it } from "vitest";
import { grepRanges, liveGrep, matchGrep, parseGrep, type GrepTerm } from "./grep";

describe("liveGrep", () => {
  it("applies positive terms as typed", () => {
    expect(liveGrep("etc")).toEqual({ apply: "etc", pendingFrom: -1 });
    expect(liveGrep("etcd run")).toEqual({ apply: "etcd run", pendingFrom: -1 });
  });

  it("holds back the negated term being typed", () => {
    expect(liveGrep("!c")).toEqual({ apply: "", pendingFrom: 0 });
    expect(liveGrep("etcd !comp")).toEqual({ apply: "etcd", pendingFrom: 5 });
    expect(liveGrep('etcd !"a b')).toEqual({ apply: "etcd", pendingFrom: 5 }); // open phrase
  });

  it("holds back an alternative being typed, from its |", () => {
    expect(liveGrep("pending | r")).toEqual({ apply: "pending", pendingFrom: 8 });
    expect(liveGrep("a  |  !b")).toEqual({ apply: "a", pendingFrom: 3 });
    expect(liveGrep("pending |")).toEqual({ apply: "pending |", pendingFrom: -1 }); // nothing to OR yet
    expect(liveGrep("pending | run ")).toEqual({ apply: "pending | run ", pendingFrom: -1 });
    expect(liveGrep("a \\| b")).toEqual({ apply: "a \\| b", pendingFrom: -1 }); // escaped: literal
    expect(liveGrep("a | b c")).toEqual({ apply: "a | b c", pendingFrom: -1 }); // c is ANDed
  });

  it("applies anchored terms as typed", () => {
    expect(liveGrep("^et")).toEqual({ apply: "^et", pendingFrom: -1 });
    expect(liveGrep("ing$")).toEqual({ apply: "ing$", pendingFrom: -1 });
  });

  it("applies a negated term once it's finished", () => {
    expect(liveGrep("etcd !completed ")).toEqual({ apply: "etcd !completed ", pendingFrom: -1 });
    expect(liveGrep('!"a b" x')).toEqual({ apply: '!"a b" x', pendingFrom: -1 });
    expect(liveGrep("\\!x")).toEqual({ apply: "\\!x", pendingFrom: -1 }); // escaped: literal
  });
});

describe("parseGrep", () => {
  // the same cases as TestParseGrep in internal/pipeline/grep_test.go
  const t = (text: string, not = false): GrepTerm => ({ text, not });
  const cases: [string, GrepTerm[]][] = [
    ["", []],
    ["etcd", [t("etcd")]],
    ["Etcd !Completed", [t("etcd"), t("completed", true)]],
    ["  a   b ", [t("a"), t("b")]],
    ['"api 0" !"x y"', [t("api 0"), t("x y", true)]],
    ["\\!foo a\\ b", [t("!foo"), t("a b")]],
    ["! a", [t("a")]],
    ["a!b", [t("a!b")]],
    ["!!x", [t("!x", true)]],
    ['"unclosed phrase', [t("unclosed phrase")]],
    ['say \\"hi\\"', [t("say"), t('"hi"')]],
    ["^web", [{ ...t("web"), prefix: true }]],
    ["ing$", [{ ...t("ing"), suffix: true }]],
    ["^Running$", [{ ...t("running"), prefix: true, suffix: true }]],
    ["!^kube-", [{ ...t("kube-", true), prefix: true }]],
    ['"^a b$"', [{ ...t("a b"), prefix: true, suffix: true }]],
    ["\\^a b\\$ c\\$$", [t("^a"), t("b$"), { ...t("c$"), suffix: true }]],
    ["^ $ ^$", []],
    ["a^b$c", [t("a^b$c")]],
    ["a | b c", [t("a"), { ...t("b"), or: true }, t("c")]],
    ["a | !b | ^c$", [t("a"), { ...t("b", true), or: true }, { ...t("c"), prefix: true, suffix: true, or: true }]],
    ["| a |", [t("a")]],
    ["a | | b", [t("a"), { ...t("b"), or: true }]],
    ['a|b \\| "|"', [t("a|b"), t("|"), t("|")]],
    ["a ||", [t("a"), t("||")]],
  ];
  it.each(cases)("%j", (input, want) => expect(parseGrep(input)).toEqual(want));
});

describe("matchGrep", () => {
  // the same cases as TestMatchGrep in internal/pipeline/grep_test.go
  const cells = ["etcd-main-0", "Running", "kube-system"];
  const cases: [string, boolean][] = [
    ["", true],
    ["etcd running", true],
    ["etcd !running", false],
    ['"0 run"', true],
    ["^etcd", true],
    ["^main", false],
    ["-0$", true],
    ["main$", false],
    ["^running$", true],
    ["^runn$", false],
    ["^kube-system$", true],
    ['"^0 running$"', false],
    ['"^etcd-main-0 running$"', true],
    ["!^kube", false],
    ["!^system", true],
    ["pending | running", true],
    ["pending | failed", false],
    ["pending | !failed", true],
    ["etcd pending | crash", false],
    ["etcd pending | ^r", true],
    ["^api | ^etcd -0$", true],
    ["^api | ^cert -0$", false],
  ];
  it.each(cases)("%j", (input, want) => expect(matchGrep(parseGrep(input), cells)).toBe(want));
});

describe("grepRanges", () => {
  const terms = (ts: string[]) => ts.map((text) => ({ text, not: false }));
  it("finds every occurrence, case-insensitively, per cell", () => {
    expect(grepRanges(["etcd-main-0", "Running", "etcd"], terms(["etcd"]))).toEqual([[[0, 4]], [], [[0, 4]]]);
    expect(grepRanges(["ETCD-etcd"], terms(["etcd"]))).toEqual([[[0, 4], [5, 9]]]);
  });
  it("merges overlapping occurrences and terms", () => {
    expect(grepRanges(["aaaa"], terms(["aa"]))).toEqual([[[0, 4]]]);
    expect(grepRanges(["etcd-main"], terms(["etcd-m", "main"]))).toEqual([[[0, 9]]]);
  });
  it("splits a phrase across cells like the joined row Go matches", () => {
    expect(grepRanges(["etcd-0", "Running"], terms(["0 run"]))).toEqual([[[5, 6]], [[0, 3]]]);
  });
  it("no terms, no ranges", () => {
    expect(grepRanges(["a", "b"], terms([]))).toEqual([[], []]);
  });
  it("highlights anchored terms only where they're anchored, not negated ones", () => {
    expect(grepRanges(["etcd-etcd", "x"], parseGrep("^etcd"))).toEqual([[[0, 4]], []]);
    expect(grepRanges(["etcd-etcd", "x"], parseGrep("etcd$"))).toEqual([[[5, 9]], []]);
    expect(grepRanges(["run", "running"], parseGrep("^run$"))).toEqual([[[0, 3]], []]);
    expect(grepRanges(["a", "b"], parseGrep("a | b"))).toEqual([[[0, 1]], [[0, 1]]]);
    expect(grepRanges(["a", "b"], parseGrep("a !b"))).toEqual([[[0, 1]], []]);
  });
  it("skips a cell whose length lower-casing changes, keeping later offsets right", () => {
    expect(grepRanges(["İx", "x"], terms(["x"]))).toEqual([[], [[0, 1]]]);
  });
});

