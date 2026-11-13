import type { PaneState } from "../store/state";
import type { ClusterEntry, Location } from "../transport/types";

export type Plane = NonNullable<Location["plane"]>;

/** Each plane's mark, word (tooltips) and badge text (short: the header's room goes to names). */
export const planes: Record<Plane, { icon: string; word: string; badge: string }> = {
  shoot: { icon: "◉", word: "shoot", badge: "SHOOT" },
  controlPlane: { icon: "⛭", word: "control plane", badge: "CP" },
  seed: { icon: "▣", word: "seed", badge: "SEED" },
  garden: { icon: "◆", word: "garden", badge: "GARDEN" },
};

/** A Gardener cluster a part of the header opens (a click: here, ⌘← goes back). */
export type Target = Pick<ClusterEntry, "garden" | "project" | "namespace" | "shoot" | "seed">;

export interface Crumb {
  text: string;
  /** Said less loudly (a kind, a note). */
  muted?: boolean;
  open?: Target;
  /** What a click does, for its tooltip and accessible name. */
  title?: string;
}

/**
 * The header's breadcrumb for a Gardener cluster: the landscape, the seed
 * beneath (a shoot's or control plane's), then the plane badge (its name in
 * it), then notes after it (what a seed is, the seed a shoot is). Undefined
 * for any other cluster: the header shows its context name.
 */
export function locationParts(l: Location | undefined): { before: Crumb[]; plane: Plane; name: string; after: Crumb[]; title: string } | undefined {
  if (!l?.plane || !l.garden) return undefined;
  const g = l.garden;
  const before: Crumb[] = [{ text: g, open: { garden: g, project: l.project }, title: `open garden ${g}${l.project ? ` in project ${l.project}` : ""}` }];
  const after: Crumb[] = [];
  const shootName = l.shoot ? `${l.project ? `${l.project}/` : ""}${l.shoot}` : "";
  let name = "";
  switch (l.plane) {
    case "shoot":
    case "controlPlane":
      // the seed's kind doesn't matter here (it's in the tooltip): the header's room goes to the shoot
      if (l.seed) before.push({ text: `seed ${l.seed}`, open: { garden: g, seed: l.seed }, title: `open seed ${l.seed}` });
      name = shootName;
      if (l.isSeed) after.push({ text: `is seed ${l.isSeed}`, open: { garden: g, seed: l.isSeed }, title: `open seed ${l.isSeed}` });
      break;
    case "seed":
      name = l.seed ?? "";
      if (l.seedKind === "managed") {
        after.push({ text: "managed · shoot", muted: true });
        if (l.seedShoot) after.push({ text: `garden/${l.seedShoot}`, open: { garden: g, namespace: "garden", shoot: l.seedShoot }, title: `open shoot garden/${l.seedShoot}` });
        if (l.seedHost) after.push({ text: "on", muted: true }, { text: `seed ${l.seedHost}`, open: { garden: g, seed: l.seedHost }, title: `open seed ${l.seedHost}` });
      } else if (l.seedKind === "unmanaged") after.push({ text: "unmanaged", muted: true });
      break;
    case "garden":
      name = l.project ? `project ${l.project}` : "";
      before.length = 0;
      before.push({ text: g, muted: true });
      break;
  }
  return { before, plane: l.plane, name, after, title: locationTitle(l) };
}

/** Everything known about where a pane is, for the breadcrumb's tooltip. */
export function locationTitle(l: Location): string {
  const lines = [`landscape: garden ${l.garden}`];
  if (l.project) lines.push(`project: ${l.project}`);
  if (l.shoot) lines.push(`shoot: ${l.shoot}${l.isSeed ? ` (the shoot of managed seed ${l.isSeed})` : ""}`);
  if (l.seed) {
    const kind = l.seedKind === "managed" ? ` (managed seed: shoot garden/${l.seedShoot ?? l.seed}${l.seedHost ? ` on seed ${l.seedHost}` : ""})` : l.seedKind === "unmanaged" ? " (unmanaged seed)" : "";
    lines.push(`seed: ${l.seed}${kind}`);
  }
  const plane = l.plane ? planes[l.plane].word : "";
  lines.push(`showing: the ${plane}${l.plane === "controlPlane" && l.project && l.shoot ? ` (namespace shoot--${l.project}--${l.shoot} on the seed)` : ""}`);
  if (l.plane === "shoot" || l.plane === "controlPlane") lines.push("⌥⌘O or a click on the badge: the other plane");
  return lines.join("\n");
}

/** The theme token of each plane's hue (fixed: apart from the safety colors). */
export const planeColor: Record<Plane, string> = {
  shoot: "var(--color-plane-shoot)",
  controlPlane: "var(--color-plane-control)",
  seed: "var(--color-plane-seed)",
  garden: "var(--color-plane-garden)",
};

/** The tab title's mark for where its pane is: the plane's icon, "" for other clusters. */
export const planeIcon = (l: Location | undefined) => (l?.plane && l.garden ? planes[l.plane].icon : "");

/**
 * The namespace that tells where a pane is (on a seed: a shoot's namespace is
 * its control plane): a local terminal's own, a node shell none (it's on the
 * node: the seed), else the pane's.
 */
export function locationNamespace(p: PaneState): string {
  if (p.term?.local) return p.term.local.namespace ?? p.spec.namespace;
  if (p.term?.ops) return "";
  return p.spec.namespace;
}
