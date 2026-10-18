/** Container ports declared in a pod's YAML (spec.containers[].ports[].containerPort). Pure. */
export function containerPorts(yaml: string): number[] {
  const out: number[] = [];
  for (const m of yaml.matchAll(/^\s*-?\s*containerPort:\s*(\d+)\s*$/gm)) {
    const p = Number(m[1]);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

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
