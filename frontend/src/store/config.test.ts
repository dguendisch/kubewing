import { describe, expect, it } from "vitest";
import { resolve } from "../keys/keymap";
import type { Config } from "../transport/types";
import { resolveConfig } from "./config";

const base: Config = { dir: "/x", config: { theme: "t", diff: { ignore: [] }, contexts: [] }, keybindings: [], theme: {}, errors: [] };

describe("resolveConfig", () => {
  it("merges keybindings and keeps known theme tokens", () => {
    const r = resolveConfig({ ...base, keybindings: [{ key: "cmd+k", command: "row.up" }], theme: { bg: "#000", accent: "#f00" } });
    expect(r.errors).toEqual([]);
    expect(resolve("Meta+K", "table", r.bindings)).toBe("row.up");
    expect(r.theme).toEqual({ bg: "#000", accent: "#f00" });
  });
  it("reports Go errors, bad bindings and unknown tokens together", () => {
    const r = resolveConfig({ ...base, errors: ["config.yaml: boom"], keybindings: [{ key: "x", command: "nope" }], theme: { sidebar: "#000" } });
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toBe("config.yaml: boom");
    expect(r.theme).toEqual({});
  });
});

