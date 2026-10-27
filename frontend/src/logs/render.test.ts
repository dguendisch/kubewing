import { describe, expect, it } from "vitest";
import type { LogLine, LogStream } from "../transport/types";
import { filterTerms, fitLabel, highlight, lineMatches, MAX_PREFIX_WIDTH, renderLines, streamLabels } from "./render";

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
    expect(text).toMatch(/^api-0 /); // one container name: the pods tell the lines apart
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

const st = (id: string, pod: string, container: string): LogStream => ({ id, pod, namespace: "shop", container, color: 0, state: "following" });

describe("streamLabels", () => {
  it("shows only what tells the streams apart", () => {
    // one pod, one container: no prefix at all
    expect(streamLabels([st("a", "api-0", "app")]).width).toBe(0);
    // one pod: its containers
    const one = streamLabels([st("a", "etcd-0", "etcd"), st("b", "etcd-0", "backup-restore")]);
    expect([...one.labels.values()]).toEqual(["etcd", "backup-restore"]);
    expect(one.width).toBe("backup-restore".length);
    // one container name: the pods
    expect([...streamLabels([st("a", "api-0", "app"), st("b", "api-1", "app")]).labels.values()]).toEqual(["api-0", "api-1"]);
    // both vary: pod/container
    expect([...streamLabels([st("a", "api-0", "app"), st("b", "api-1", "side")]).labels.values()]).toEqual(["api-0/app", "api-1/side"]);
  });
  it("caps the column width", () => {
    const long = "x".repeat(60);
    expect(streamLabels([st("a", "p", long), st("b", "p", "app")]).width).toBe(MAX_PREFIX_WIDTH);
  });
});

describe("fitLabel", () => {
  it("pads short labels and cuts long ones in the middle, keeping the end", () => {
    expect(fitLabel("app", 6)).toBe("app   ");
    const a = fitLabel("etcd-main-0/backup-restore-sidecar-one", 20);
    const b = fitLabel("etcd-main-0/backup-restore-sidecar-two", 20);
    expect(a).toHaveLength(20);
    expect(a).toMatch(/^etcd-m…/);
    expect(a.endsWith("sidecar-one")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("renderLines prefix", () => {
  it("leaves the prefix out for a single stream, but still filters on its names", () => {
    const one = [st("a", "api-0", "app")];
    expect(plain(renderLines([line("a", "hello")], { prefix: true, timestamps: false, terms: [], streams: one })[0]!)).toBe("hello");
    expect(renderLines([line("a", "hello")], { prefix: true, timestamps: false, terms: filterTerms("api-0"), streams: one })).toHaveLength(1);
  });
  it("lines up the text after a prefix fitted to the longest label", () => {
    const two = [st("a", "etcd-0", "etcd"), st("b", "etcd-0", "backup-restore")];
    const out = renderLines([line("a", "x"), line("b", "y")], { prefix: true, timestamps: false, terms: [], streams: two }).map((l) => plain(l));
    expect(out).toEqual(["etcd           x", "backup-restore y"]);
  });
});
