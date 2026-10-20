import type { Candidate } from "../complete/complete";
import { debugProfiles, type ContainerInfo, type DebugConfig, type DebugOptions, type DebugProfile } from "../transport/types";

/** The image field's suggestions: the configured default, then recent ones (Go's history.yaml). */
export function imageSuggestions(cfg: DebugConfig | undefined, recent: string[]): string[] {
  return [...new Set([...(cfg?.image ? [cfg.image] : []), ...recent])];
}

/** What each profile does to the debug container (kubectl debug --profile). */
export const profileHints: Record<DebugProfile, string> = {
  general: "SYS_PTRACE: strace, gdb on the target's processes",
  baseline: "no extra privileges",
  restricted: "non-root, all capabilities dropped",
  netadmin: "NET_ADMIN + NET_RAW: tcpdump, iptables",
  sysadmin: "privileged",
};

/** Containers a debug container can target: not ephemeral ones (as kubectl). An empty field = none. */
export function targetCandidates(cs: ContainerInfo[]): Candidate[] {
  return cs
    .filter((c) => c.kind !== "ephemeral")
    .map((c) => ({
      value: c.name,
      label: c.name,
      detail: [c.kind === "container" ? "" : c.kind, c.reason ?? c.state ?? "", c.default ? "default" : ""].filter(Boolean).join(" · ") || undefined,
    }));
}

export const profileCandidates: Candidate[] = debugProfiles.map((p) => ({ value: p, label: p, detail: profileHints[p] }));

/**
 * The dialog's values as Go takes them, or what's wrong with them. Target
 * and profile are free text (completion fields) but must name one of the
 * choices; an empty target means none (no shared processes). Pure.
 */
export function checkDebug(o: DebugOptions, cs: ContainerInfo[]): { opts: DebugOptions } | { error: string } {
  const image = o.image.trim(), target = o.target.trim(), profile = o.profile.trim() || "general";
  if (!image) return { error: "an image is needed, e.g. busybox" };
  const targets = targetCandidates(cs).map((c) => c.value);
  if (target && !targets.includes(target)) return { error: `no container "${target}" to target (${targets.join(", ") || "none"}; empty = none)` };
  if (!(debugProfiles as readonly string[]).includes(profile)) return { error: `unknown profile "${profile}" (${debugProfiles.join(", ")})` };
  return { opts: { image, target: target || "-", profile } };
}

/**
 * Initial dialog values: the configured image, else the last one that
 * started; the pod's default container as target ("" = none); the configured profile.
 */
export function initialDebug(cfg: DebugConfig | undefined, cs: ContainerInfo[], recent: string[] = []): DebugOptions {
  const target = cs.find((c) => c.default)?.name ?? cs.find((c) => c.kind !== "ephemeral")?.name ?? "";
  return { image: cfg?.image ?? recent[0] ?? "", target, profile: cfg?.profile ?? "general" };
}
