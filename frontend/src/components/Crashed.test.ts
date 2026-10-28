import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Crashed } from "./Crashed";

const Boom = () => {
  throw new TypeError("Cannot read properties of undefined (reading 'start')");
};

describe("Crashed", () => {
  it("shows the children while they render", () => {
    expect(renderToString(createElement(Crashed, { what: "this pane", children: "fine" }))).toBe("fine");
  });

  it("shows the error in their place when they throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = Crashed.getDerivedStateFromError(new TypeError("boom"));
    const c = new Crashed({ what: "this pane", children: createElement(Boom) });
    c.state = state;
    const html = renderToString(c.render() as React.ReactElement);
    expect(html).toContain('aria-label="this pane crashed"');
    expect(html).toContain("TypeError: boom");
    expect(html).toContain("retry");
  });
});
