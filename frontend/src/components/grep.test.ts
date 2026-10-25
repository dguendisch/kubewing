import { describe, expect, it } from "vitest";
import { liveGrep, parseGrep } from "./grep";

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

  it("applies a negated term once it's finished", () => {
    expect(liveGrep("etcd !completed ")).toEqual({ apply: "etcd !completed ", pendingFrom: -1 });
    expect(liveGrep('!"a b" x')).toEqual({ apply: '!"a b" x', pendingFrom: -1 });
    expect(liveGrep("\\!x")).toEqual({ apply: "\\!x", pendingFrom: -1 }); // escaped: literal
  });
});

describe("parseGrep", () => {
  // the same cases as TestParseGrep in internal/pipeline/grep_test.go
  const t = (text: string, not = false) => ({ text, not });
  const cases: [string, ReturnType<typeof t>[]][] = [
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
  ];
  it.each(cases)("%j", (input, want) => expect(parseGrep(input)).toEqual(want));
});
