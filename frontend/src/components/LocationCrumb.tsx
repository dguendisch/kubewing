import { useEffect, type CSSProperties } from "react";
import { openTarget, switchPanePlane } from "../commands";
import { bridge } from "../store/store";
import { loadLocation, locationKey, useLocations } from "../store/location";
import { neverUsed, type Location } from "../transport/types";
import { locationParts, planeColor, planes, type Crumb } from "./location";

/** A pane's location (bridge.Location), fetched once per cluster and namespace. */
export function useLocation(cluster: string, namespace: string): Location | undefined {
  const l = useLocations((m) => m[locationKey(cluster, namespace)]);
  useEffect(() => {
    loadLocation(cluster, namespace, (c, ns) => bridge().location(c, ns));
  }, [cluster, namespace, l]);
  return l;
}

/**
 * The header's "where am I" on a Gardener cluster: landscape › seed › the
 * plane badge (shoot, control plane, seed, garden) and its name, then what a
 * seed is (managed, its shoot and host; unmanaged). A click on a part opens
 * that cluster in the pane, on the badge switches shoot ⇄ control plane (⌥⌘O).
 * Other clusters: their context name (fallback), as before.
 */
export function LocationCrumb({ paneId, location, fallback, fallbackTitle }: { paneId: string; location?: Location; fallback: string; fallbackTitle?: string }) {
  const parts = locationParts(location);
  if (!parts) {
    return (
      <span className="shrink-0 text-fg-muted" title={fallbackTitle}>
        {fallback}
      </span>
    );
  }
  return <Crumbs paneId={paneId} parts={parts} context={fallback} />;
}

function Crumbs({ paneId, parts, context }: { paneId: string; parts: NonNullable<ReturnType<typeof locationParts>>; context: string }) {
  const { word, icon, badge } = planes[parts.plane];
  const switchable = parts.plane === "shoot" || parts.plane === "controlPlane";
  const color = planeColor[parts.plane];
  return (
    // as wide as its texts while there's room; short of it, never less than its parts' least (the header's other parts give way too)
    <span aria-label="location" data-plane={parts.plane} title={`${parts.title}\ncontext: ${context}`} className="flex items-center gap-1 whitespace-nowrap" style={{ flex: "0 1 auto", minWidth: leastWidth(parts, icon, badge) }}>
      {/*
        short of room, landscape and seed give way first (down to a few letters, …), then the notes after the
        name, the name last; the badge never. One after the other, not all a bit (flex-shrink would share the
        shortage): landscape and seed sit in a box of their own, which alone may shrink below its content
        (min-width 0) down to its parts' least, while name and notes hold their full width until then
      */}
      {parts.before.length ? (
        <span className="flex items-center gap-1" style={{ flex: "0 1 auto", minWidth: beforeWidth(parts.before) }}>
          {parts.before.map((c, i) => (
            <span key={i} className="contents">
              <CrumbPart paneId={paneId} crumb={c} style={fit(c.text, beforeMin, 1)} />
              <span className="shrink-0 text-fg-muted">›</span>
            </span>
          ))}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={`plane ${word}`}
        title={switchable ? `${word}: ⌥⌘O switches to the ${parts.plane === "shoot" ? "control plane" : "shoot"}` : word}
        disabled={!switchable}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => switchable && switchPanePlane(paneId)}
        // an outlined chip: a light tint of the plane's hue, a sharp border in it, rounded
        className={`shrink-0 rounded-md border px-1.5 leading-4 font-semibold ${switchable ? "cursor-pointer hover:brightness-125" : "cursor-default"}`}
        style={{ color, borderColor: color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
      >
        {icon} {badge}
      </button>
      {parts.name ? (
        <span className="truncate font-semibold" style={{ color, ...fit(parts.name, nameMin, 0.001) }}>
          {parts.name}
        </span>
      ) : null}
      {parts.after.map((c, i) => (
        <CrumbPart key={i} paneId={paneId} crumb={c} style={fit(c.text, afterMin, 0.01)} />
      ))}
    </span>
  );
}

/**
 * The breadcrumb's least width: each part's least (see fit), the
 * separators, the badge whole (padding and border), the gaps, 1ch spare for
 * the icons' glyphs. Counted, not measured: the header lays out the same
 * whatever was shown before (a background tab, a narrower window).
 */
/** The landscape and seed box's least width: its parts' least, the separators, the gaps between them. */
function beforeWidth(before: Crumb[]): string {
  const chars = before.reduce((n, c) => n + least(c.text, beforeMin) + 1, 0);
  return `calc(${chars}ch + ${before.length * 2 - 1} * 0.25rem)`;
}

function leastWidth(parts: NonNullable<ReturnType<typeof locationParts>>, icon: string, badge: string): string {
  const chars =
    parts.before.reduce((n, c) => n + least(c.text, beforeMin) + 1, 0) +
    (parts.name ? least(parts.name, nameMin) : 0) +
    parts.after.reduce((n, c) => n + least(c.text, afterMin), 0) +
    icon.length + 1 + badge.length + 1;
  const items = parts.before.length * 2 + 1 + (parts.name ? 1 : 0) + parts.after.length;
  return `calc(${chars}ch + ${items - 1} * 0.25rem + 0.75rem + 2px)`;
}

const beforeMin = 4;
const nameMin = 6;
const afterMin = 3;
const least = (text: string, min: number) => Math.min(min, text.length);

/**
 * A part that gives way to an ellipsis: as wide as its text while there's
 * room, shrinking (by shrink: the landscape and seed long before the name)
 * down to min letters (the font is monospace). The explicit least width
 * replaces the text's own, so a part can shrink at all.
 */
const fit = (text: string, min: number, shrink: number): CSSProperties => ({
  flex: `0 ${shrink} auto`,
  minWidth: `${least(text, min)}ch`,
});

function CrumbPart({ paneId, crumb, style }: { paneId: string; crumb: Crumb; style: CSSProperties }) {
  const target = crumb.open;
  if (!target)
    return (
      <span className={`truncate ${crumb.muted ? "text-fg-muted" : ""}`} style={style}>
        {crumb.text}
      </span>
    );
  return (
    <button
      type="button"
      title={crumb.title}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void openTarget(paneId, { ...target, used: neverUsed, from: "jump", rule: { context: "", confirm: [] } }, crumb.text)}
      className="truncate text-left text-fg-muted hover:text-fg hover:underline"
    >
      {crumb.text}
    </button>
  );
}
