import type { Candidate } from "../complete/complete";
import type { NodeInfo, OpsPodConfig, OpsPodDefaults, OpsPodOptions } from "../transport/types";

/** The image field's suggestions: the configured default, then recent ones (shared with debug containers). */
export function opsImageSuggestions(cfg: OpsPodConfig | undefined, recent: string[]): string[] {
  return [...new Set([...(cfg?.image ? [cfg.image] : []), ...recent])];
}

/** One node in a few words: "worker-a · eu-1b · cordoned"; not-ready nodes say so first. */
export function nodeDetail(n: NodeInfo): string | undefined {
  const ready = n.ready === undefined || n.ready === "True" ? "" : n.ready === "Unknown" ? "not ready (unknown)" : "not ready";
  return [ready, n.pool ?? "", n.zone ?? "", n.unschedulable ? "cordoned" : ""].filter(Boolean).join(" · ") || undefined;
}

/** Completion for the node field: every node, with pool, zone and state. Not-ready ones still count (that's often why one looks). */
export function nodeCandidates(nodes: NodeInfo[]): Candidate[] {
  return nodes.map((n) => ({ value: n.name, label: n.name, detail: nodeDetail(n) }));
}

/** What each checkbox does to the pod, for the hint line. */
export function opsPodHint(o: Pick<OpsPodOptions, "hostRoot" | "chroot" | "hostNetwork">): string {
  const parts = ["privileged, host PID"];
  if (o.chroot) parts.push("node's / at /host, shell chrooted into it");
  else if (o.hostRoot) parts.push("node's / at /host");
  if (o.hostNetwork) parts.push("host network");
  return parts.join(" · ") + " · deleted when the shell ends";
}

/** The dialog's values as Go takes them, or what's wrong with them. Pure. */
export function checkOpsPod(node: string, o: OpsPodOptions, nodes: NodeInfo[] | undefined): { node: string; opts: OpsPodOptions } | { error: string } {
  const n = node.trim(), image = o.image.trim(), namespace = o.namespace.trim();
  if (!n) return { error: "a node is needed" };
  // nodes not known yet (still listing, or no permission): Go and the API server decide
  if (nodes?.length && !nodes.some((x) => x.name === n)) return { error: `no node "${n}" (↓ lists them)` };
  if (!image) return { error: "an image is needed, e.g. the ops-toolbelt" };
  if (/\s/.test(image)) return { error: `"${image}" is not an image` };
  if (namespace && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) return { error: `"${namespace}" is not a namespace name` };
  return { node: n, opts: { image, namespace, hostRoot: o.hostRoot || o.chroot, chroot: o.chroot, hostNetwork: o.hostNetwork } };
}

/** Initial dialog values, as Go decided them (last used, else config.yaml, else host root + host network). */
export function initialOpsPod(d: OpsPodDefaults | undefined): OpsPodOptions {
  if (!d) return { image: "", namespace: "", chroot: false, hostRoot: true, hostNetwork: true };
  return { image: d.image, namespace: d.namespace, chroot: d.chroot, hostRoot: d.hostRoot || d.chroot, hostNetwork: d.hostNetwork };
}

/** Namespace completion: the context's namespaces (catalog), the remembered one first. */
export function opsNamespaceCandidates(namespaces: string[], last: string): Candidate[] {
  const list = [...new Set([...(last ? [last] : []), ...namespaces])];
  return list.map((n) => ({ value: n, label: n, detail: n === last ? "last used" : undefined }));
}
