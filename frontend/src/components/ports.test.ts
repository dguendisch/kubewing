import { describe, expect, it } from "vitest";
import { defaultLocal, describeForward, forwardedRemotes, forwardsTo, forwardTarget, lastToken, listedRemotes, parsePorts, portCandidates } from "./ports";
import { rank } from "../complete/complete";

describe("ports", () => {
  it("parses and validates port specs", () => {
    expect(parsePorts("8080:80 9090, :443")).toEqual(["8080:80", "9090", ":443"]);
    expect(parsePorts("  ")).toBe("no ports given");
    expect(parsePorts("80:abc")).toContain('invalid port "80:abc"');
    expect(parsePorts("70000")).toContain("invalid");
    expect(parsePorts("1:2:3")).toContain("invalid");
  });

  // as a real CoreDNS pod declares them: 53 twice (UDP and TCP)
  const ports = [
    { port: 53, name: "dns", protocol: "UDP", container: "coredns" },
    { port: 53, name: "dns-tcp", protocol: "TCP", container: "coredns" },
    { port: 9153, name: "metrics", protocol: "TCP", container: "coredns" },
    { port: 8080, container: "side" }, // no name, no protocol (Kubernetes defaults to TCP)
    { port: 5353, name: "mdns", protocol: "UDP", container: "side" },
  ];

  it("offers each port number once; repeated declarations are listed together", () => {
    expect(portCandidates(ports)).toEqual([
      // also TCP: forwardable; below 1000 the local port gets 8000 added (no root needed)
      { value: "8053:53", label: "53", detail: "dns, dns-tcp · UDP/TCP · coredns", aliases: ["dns", "dns-tcp"] },
      { value: "9153:9153", label: "9153", detail: "metrics · TCP · coredns", aliases: ["metrics"] },
      { value: "8080:8080", label: "8080", detail: "TCP · side", aliases: [] },
      // UDP only: listed, but port-forward can't carry it
      { value: "5353:5353", label: "5353", detail: "mdns · UDP · side · can't forward", aliases: ["mdns"], disabled: "port-forward is TCP only" },
    ]);
  });

  it("defaults low remote ports to a local port above 8000", () => {
    expect([53, 80, 443, 8, 999, 1000, 8080].map(defaultLocal)).toEqual([8053, 8080, 8443, 8008, 8999, 1000, 8080]);
  });

  it("matches by number or name", () => {
    const c = portCandidates(ports);
    expect(rank("91", c).map((m) => m.candidate.label)).toEqual(["9153"]);
    expect(rank("met", c).map((m) => m.candidate.label)).toEqual(["9153"]);
    expect(rank("dns-tcp", c).map((m) => m.candidate.label)).toEqual(["53"]);
  });

  it("finds a pod's forwards and which remote ports they already cover", () => {
    const fw = (id: string, ctx: string, ns: string, pod: string, remote: number, error?: string) => ({ id, context: ctx, namespace: ns, pod, ports: [{ local: 10000 + remote, remote }], error });
    const list = [fw("f1", "kind", "kube-system", "coredns", 9153), fw("f2", "kind", "kube-system", "coredns", 53, "ended"), fw("f3", "kind", "default", "coredns", 8080), fw("f4", "dev", "kube-system", "coredns", 8181)];
    const mine = forwardsTo(list, "kind", "kube-system", "coredns");
    expect(mine.map((f) => f.id)).toEqual(["f1", "f2"]);
    // an ended forward doesn't hold its port any more: it can be offered again
    expect([...forwardedRemotes(mine)]).toEqual([9153]);
    expect(describeForward(mine[0]!)).toBe("127.0.0.1:19153 → 9153");
    expect(forwardTarget(mine[0]!)).toBe("kube-system/coredns");
  });

  it("keeps a service's forwards apart from its pod's, by service port", () => {
    const viaSvc = { id: "f5", context: "kind", namespace: "shop", pod: "web-a", service: "web", ports: [{ local: 8080, remote: 8080, service: 80 }] };
    const direct = { id: "f6", context: "kind", namespace: "shop", pod: "web-a", ports: [{ local: 9090, remote: 9090 }] };
    const list = [viaSvc, direct];
    expect(forwardsTo(list, "kind", "shop", "web", true).map((f) => f.id)).toEqual(["f5"]);
    expect(forwardsTo(list, "kind", "shop", "web-a").map((f) => f.id)).toEqual(["f6"]);
    // the service dialog offers service ports: 80 is taken, not 8080
    expect([...forwardedRemotes([viaSvc])]).toEqual([80]);
    expect(describeForward(viaSvc)).toBe("127.0.0.1:8080 → svc 80 → 8080");
    expect(forwardTarget(viaSvc)).toBe("shop/svc/web → web-a");
  });

  it("shows a service port's target when it differs", () => {
    const svc = [
      { port: 80, name: "http", protocol: "TCP", target: "http" },
      { port: 9090, name: "metrics", protocol: "TCP", target: "9090" },
      { port: 53, name: "dns", protocol: "UDP", target: "5353" },
    ];
    expect(portCandidates(svc).map((c) => [c.value, c.detail])).toEqual([
      ["8080:80", "http · TCP · → http"],
      ["9090:9090", "metrics · TCP"],
      ["8053:53", "dns · UDP · → 5353 · can't forward"],
    ]);
  });

  it("finds the token being completed and the ports already listed", () => {
    expect(lastToken("8080:8080 90")).toEqual({ from: 10, word: "90" });
    expect(lastToken("8080:8080 ")).toEqual({ from: 10, word: "" });
    expect(lastToken("")).toEqual({ from: 0, word: "" });
    expect([...listedRemotes("8080:80 9090, :443")]).toEqual([80, 9090, 443]);
  });
});
