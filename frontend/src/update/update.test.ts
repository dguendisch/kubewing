import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";
import { hint, phaseText, resolveLink, restartWarning, scheduleText, summary } from "./update";
import type { UpdateStatus } from "../transport/types";

const offer = { version: "0.3.0", notes: [], url: "https://github.com/dguendisch/kubewing/releases/tag/v0.3.0", size: 42_000_000 };
const st = (s: Partial<UpdateStatus>): UpdateStatus => ({ current: "0.2.0", released: true, checkDays: 1, ...s });

describe("hint", () => {
  it("shows an offer unless that version is skipped", () => {
    expect(hint(st({ offer }))?.version).toBe("0.3.0");
    expect(hint(st({ offer, skipped: "0.3.0" }))).toBeUndefined();
    // a newer one than the skipped shows again
    expect(hint(st({ offer, skipped: "0.2.5" }))?.version).toBe("0.3.0");
    expect(hint(st({}))).toBeUndefined();
    expect(hint(undefined)).toBeUndefined();
  });
});

describe("summary", () => {
  it("says what the check found", () => {
    expect(summary(st({ offer }))).toBe("kubewing 0.3.0 is available, you have 0.2.0");
    expect(summary(st({ lastCheck: "2026-11-06T10:00:00Z" }))).toBe("kubewing 0.2.0 is up to date");
    expect(summary(st({ released: false, current: "0.2.0-3-gabc" }))).toMatch(/development build/);
    expect(summary(st({ checking: true }))).toBe("checking for updates…");
    expect(summary(st({ offer, installing: "download", progress: 0.426 }))).toBe("downloading… 42%");
    // the error is shown on its own
    expect(summary(st({ error: "offline" }))).toBe("");
  });
  it("names the phases", () => {
    expect(phaseText("verify")).toMatch(/verifying/);
    expect(phaseText("restart")).toMatch(/restarting/);
  });
});

describe("scheduleText", () => {
  it("daily, every n days, off", () => {
    expect(scheduleText(1)).toMatch(/daily/);
    expect(scheduleText(7)).toMatch(/every 7 days/);
    expect(scheduleText(0)).toMatch(/off/);
  });
});

describe("restartWarning", () => {
  it("counts what ends", () => {
    expect(restartWarning(0, 0)).toMatch(/restarts/);
    expect(restartWarning(1, 0)).toBe("restarting ends 1 terminal or log pane");
    expect(restartWarning(2, 3)).toBe("restarting ends 2 terminal or log panes and 3 port-forwards");
    expect(restartWarning(0, 1)).toBe("restarting ends 1 port-forward");
  });
});

describe("resolveLink", () => {
  it("relative links point into the repository at the version", () => {
    expect(resolveLink("Manual.md#installing", "0.3.0")).toBe("https://github.com/dguendisch/kubewing/blob/v0.3.0/Manual.md#installing");
    expect(resolveLink("./docs/a.md", "0.3.0")).toBe("https://github.com/dguendisch/kubewing/blob/v0.3.0/docs/a.md");
    expect(resolveLink("#highlights", "0.3.0")).toBe("https://github.com/dguendisch/kubewing/blob/v0.3.0/README.md#highlights");
  });
  it("web links stay, other schemes are dropped", () => {
    expect(resolveLink("https://github.com/dguendisch/kubewing#highlights", "0.3.0")).toBe("https://github.com/dguendisch/kubewing#highlights");
    expect(resolveLink("javascript:alert(1)", "0.3.0")).toBeUndefined();
    expect(resolveLink("JavaScript:alert(1)", "0.3.0")).toBeUndefined();
    expect(resolveLink("file:///etc/passwd", "0.3.0")).toBeUndefined();
    expect(resolveLink("//evil.example/x", "0.3.0")).toBeUndefined();
    expect(resolveLink("", "0.3.0")).toBeUndefined();
  });
});

const render = (md: string) => renderToStaticMarkup(createElement(Markdown, { text: md, onLink: () => {}, resolve: (h: string) => resolveLink(h, "0.3.0") }));

describe("Markdown", () => {
  it("renders a changelog section", () => {
    const html = render("### Added\n- **Updates:** a `hint` & [manual](Manual.md#updates)\n  - nested\n\n### Fixed\n1. one");
    expect(html).toContain("<h4");
    expect(html).toContain(">Added</h4>");
    expect(html).toContain("<ul");
    expect(html).toContain("<strong");
    expect(html).toContain(">hint</code>");
    expect(html).toContain(" &amp; ");
    expect(html).toContain('href="https://github.com/dguendisch/kubewing/blob/v0.3.0/Manual.md#updates"');
    expect(html).toContain(">nested</li>");
    expect(html).toContain("<ol");
  });
  it("never injects HTML", () => {
    const html = render('hi <img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n<div onclick="x()">block</div>');
    expect(html).not.toMatch(/<img|<script|<div onclick/);
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });
  it("drops links it may not follow, keeps their text", () => {
    const html = render("[click](javascript:alert(1)) and ![pic](https://example.com/p.png)");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
    // images aren't loaded: a link with the alt text
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/p.png"');
  });
  it("code blocks keep their text", () => {
    expect(render("```\na < b && c\n```")).toContain("a &lt; b &amp;&amp; c");
  });
});
