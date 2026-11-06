import type { Candidate } from "../complete/complete";
import type { PortForward, PortInfo } from "../transport/types";

/**
 * The forwards to one pod, or started on one service (service = true), in
 * the same context and namespace. A pod's dialog lists those to the pod
 * itself, not those a service picked it for. Pure.
 */
export function forwardsTo(list: PortForward[], context: string | undefined, namespace: string | undefined, name: string, service = false): PortForward[] {
  return list.filter((f) => f.context === context && f.namespace === (namespace ?? "") && (service ? f.service === name : !f.service && f.pod === name));
}

/** Remote ports already forwarded by live (not ended) forwards; a service's are its service ports. Pure. */
export function forwardedRemotes(list: PortForward[]): Set<number> {
  return new Set(list.filter((f) => !f.error).flatMap((f) => f.ports.map((p) => p.service ?? p.remote)));
}

/** "127.0.0.1:18080 → 8080, …"; a service's: "127.0.0.1:8080 → svc 80 → 8080" (service port, then the pod's) */
export const describeForward = (f: PortForward) =>
  f.ports.map((p) => `127.0.0.1:${p.local} → ${f.service && p.service !== undefined ? `svc ${p.service} → ` : ""}${p.remote}`).join(", ");

/** Where a forward goes: "ns/pod", or "ns/svc/web → pod" for a service. */
export const forwardTarget = (f: PortForward) => (f.service ? `${f.namespace}/svc/${f.service} → ${f.pod}` : `${f.namespace}/${f.pod}`);

/**
 * Parses "8080:80 9090" (space or comma separated) into bridge port specs;
 * returns an error message for invalid input. Pure.
 */
export function parsePorts(s: string): string[] | string {
  const parts = s.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return "no ports given";
  const valid = (p: string) => /^\d+$/.test(p) && Number(p) > 0 && Number(p) < 65536;
  for (const p of parts) {
    const [l, r, extra] = p.split(":");
    const ok = extra === undefined && (r === undefined ? valid(l!) : (l === "" || valid(l!)) && valid(r));
    if (!ok) return `invalid port "${p}" (use local:remote or remote, 1–65535)`;
  }
  return parts;
}

/**
 * The default local port for a remote one: the same, except below 1000,
 * where binding needs root on macOS/Linux; those get 8000 added ("8" or
 * "80" prepended): 53 → 8053, 443 → 8443, 80 → 8080. Pure.
 */
export const defaultLocal = (remote: number) => (remote < 1000 ? 8000 + remote : remote);

/**
 * Completion candidates for the declared ports (or a service's ports): one per port number,
 * inserted as "local:remote" (see defaultLocal). A number declared more than once (CoreDNS: 53 as "dns"
 * UDP and "dns-tcp" TCP) is one entry listing all of them. Names, protocols
 * and containers show as detail; names match as aliases ("met" finds
 * metrics). Pure.
 */
export function portCandidates(ports: PortInfo[]): Candidate[] {
  const byPort = new Map<number, PortInfo[]>();
  for (const p of ports) byPort.set(p.port, [...(byPort.get(p.port) ?? []), p]);
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  return [...byPort].map(([port, decl]) => {
    const names = uniq(decl.map((d) => d.name));
    const protos = uniq(decl.map((d) => d.protocol ?? "TCP"));
    // port-forward carries TCP only (kubectl refuses UDP-only ports too)
    const tcp = protos.includes("TCP");
    // a service port goes to its target port on the pod (shown unless it's the same number)
    const targets = uniq(decl.map((d) => d.target)).filter((t) => t !== String(port));
    return {
      value: `${defaultLocal(port)}:${port}`,
      label: String(port),
      detail: [
        names.join(", "),
        protos.join("/"),
        uniq(decl.map((d) => d.container)).join(", "),
        targets.length ? `→ ${targets.join(", ")}` : "",
        tcp ? "" : "can't forward",
      ].filter(Boolean).join(" · "),
      aliases: names,
      ...(tcp ? {} : { disabled: "port-forward is TCP only" }),
    };
  });
}

/** The last space/comma-separated token of a port list (the one being completed) and where it starts. Pure. */
export function lastToken(s: string): { from: number; word: string } {
  const m = s.match(/[^\s,]*$/)!;
  return { from: s.length - m[0].length, word: m[0] };
}

/** Remote ports already listed ("8080:80 9090" → 80, 9090), so they aren't offered again. Pure. */
export function listedRemotes(s: string): Set<number> {
  const out = new Set<number>();
  for (const p of s.split(/[\s,]+/).filter(Boolean)) {
    const r = Number(p.split(":").pop());
    if (r) out.add(r);
  }
  return out;
}
