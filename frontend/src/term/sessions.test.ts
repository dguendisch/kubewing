import { describe, expect, it } from "vitest";
import { b64decode, b64encode, sessions } from "./sessions";

describe("sessions", () => {
  it("buffers output until a terminal attaches, then streams", () => {
    const got: string[] = [];
    const dec = new TextDecoder();
    sessions.push("s1", new TextEncoder().encode("a"));
    sessions.push("s1", new TextEncoder().encode("b"));
    const off = sessions.attach("s1", (c) => got.push(c instanceof Uint8Array ? dec.decode(c) : `exit:${c.exit}`));
    sessions.push("s1", new TextEncoder().encode("c"));
    sessions.push("s1", { exit: 0 });
    expect(got).toEqual(["a", "b", "c", "exit:0"]);
    off();
    sessions.drop("s1");
  });

  it("a terminal attaching again (StrictMode, a pane moving) gets the whole transcript, not a blank screen", () => {
    const dec = new TextDecoder();
    const text = (into: string[]) => (c: Uint8Array | { exit: number | string }) => into.push(c instanceof Uint8Array ? dec.decode(c) : `exit:${c.exit}`);
    sessions.push("s3", new TextEncoder().encode("banner "));
    const first: string[] = [];
    const off = sessions.attach("s3", text(first));
    off(); // unmounted right away, as StrictMode does
    sessions.push("s3", new TextEncoder().encode("$ ")); // while no terminal is attached
    const second: string[] = [];
    sessions.attach("s3", text(second));
    sessions.push("s3", new TextEncoder().encode("ls"));
    expect(first).toEqual(["banner "]);
    expect(second).toEqual(["banner ", "$ ", "ls"]);
    sessions.drop("s3");
    const after: string[] = [];
    sessions.attach("s3", text(after));
    expect(after).toEqual([]); // dropped: nothing left to replay
    sessions.drop("s3");
  });

  it("bounds the buffer, keeping the newest output", () => {
    const chunk = new Uint8Array(100 * 1024);
    for (let i = 0; i < 5; i++) sessions.push("s2", chunk);
    let n = 0;
    sessions.attach("s2", (c) => (n += c instanceof Uint8Array ? c.length : 0));
    expect(n).toBeLessThanOrEqual(256 * 1024);
    expect(n).toBeGreaterThan(0);
    sessions.drop("s2");
  });

  it("base64 round-trips UTF-8", () => {
    expect(new TextDecoder().decode(b64decode(b64encode("ünïcode ✓ $ ")))).toBe("ünïcode ✓ $ ");
  });
});
