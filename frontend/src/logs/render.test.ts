import { describe, expect, it } from "vitest";
import type { LogLine, LogStream } from "../transport/types";
import { filterTerms, highlight, lineMatches, renderLines } from "./render";

const streams: LogStream[] = [
  { id: "p1/app", pod: "api-0", namespace: "shop", container: "app", color: 0, state: "following" },
  { id: "p2/app", pod: "api-1", namespace: "shop", container: "app", color: 1, state: "following" },
];

const line = (stream: string, text: string, ts?: string): LogLine => ({ stream, text, ts });

// strip ANSI escapes so assertions read the visible text
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n$/, "");

describe("lineMatches", () => {
  it("requires every positive term and excludes negated ones", () => {
    const t = filterTerms("ready !warning");
    expect(lineMatches("api-0 app ready", t)).toBe(true);
    expect(lineMatches("api-0 app warning ready", t)).toBe(false); // negated term present
    expect(lineMatches("api-0 app starting", t)).toBe(false); // missing "ready"
  });
  it("matches the pod and container too, so typing a pod narrows", () => {
    const t = filterTerms("api-1");
    expect(lineMatches("api-1 app whatever", t)).toBe(true);
    expect(lineMatches("api-0 app whatever", t)).toBe(false);
  });
});

describe("highlight", () => {
  it("wraps positive terms, leaves negated ones alone", () => {
    const out = highlight("disk space low", filterTerms("space !low"));
    // the match is wrapped in inverse video, then reset
    expect(out).toContain("\x1b[7mspace\x1b[0m");
    expect(out).not.toContain("\x1b[7mlow");
  });
});

describe("renderLines", () => {
  it("filters, prefixes with pod/container and shows timestamps when asked", () => {
    const lines = [line("p1/app", "ready", "2026-01-01T00:00:00Z"), line("p2/app", "starting", "2026-01-01T00:00:01Z")];
    const out = renderLines(lines, { prefix: true, timestamps: true, terms: filterTerms("ready"), streams });
    expect(out).toHaveLength(1);
    const text = plain(out[0]!);
    expect(text).toContain("api-0/app");
    expect(text).toContain("2026-01-01T00:00:00Z");
    expect(text).toContain("ready");
  });

  it("keeps marker lines regardless of the filter", () => {
    const lines = [line("p1/app", "— stream ended —"), line("p1/app", "noise")];
    const out = renderLines(lines, { prefix: true, timestamps: false, terms: filterTerms("nothingmatches"), streams });
    expect(out).toHaveLength(1);
    expect(plain(out[0]!)).toContain("stream ended");
  });

  it("omits the prefix when asked (single-pod view)", () => {
    const out = renderLines([line("p1/app", "hello")], { prefix: false, timestamps: false, terms: [], streams });
    expect(plain(out[0]!)).toBe("hello");
  });
});
