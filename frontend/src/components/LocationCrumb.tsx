import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { openTarget, switchPanePlane } from "../commands";
import { bridge } from "../store/store";
import { loadLocation, locationKey, useLocations } from "../store/location";
import { neverUsed, type Location, type SafetyRule } from "../transport/types";
import { ruleColor } from "./safetyStyle";
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
export function LocationCrumb({
  paneId,
  location,
  fallback,
  fallbackTitle,
  landscapeRule,
  landscapeChip = true,
}: {
  paneId: string;
  location?: Location;
  fallback: string;
  fallbackTitle?: string;
  /** safety.label: landscape: the rule whose label the landscape crumb reads, as a chip. */
  landscapeRule?: SafetyRule;
  /** safety.chip: false: that label as its text in the rule's color, no chip. */
  landscapeChip?: boolean;
}) {
  const parts = locationParts(location);
  if (!parts) {
    return (
      <span className="shrink-0 text-fg-muted" title={fallbackTitle}>
        {fallback}
      </span>
    );
  }
  return <Crumbs paneId={paneId} parts={landscapeRule ? labelLandscape(parts, landscapeRule, !landscapeChip) : parts} context={fallback} />;
}

/**
 * The landscape crumb as the safety rule's chip: its label for text (the
 * landscape's name in its tooltip), its color, square as safety labels are;
 * plain (safety.chip: false), the label's text in that color alone.
 */
function labelLandscape(parts: NonNullable<ReturnType<typeof locationParts>>, rule: SafetyRule, plain: boolean): NonNullable<ReturnType<typeof locationParts>> {
  const [first, ...rest] = parts.before;
  if (!first) return parts;
  const g = location(first);
  return {
    ...parts,
    before: [{ ...first, text: rule.label ?? first.text, safety: rule, plain, title: `${g}${first.open ? ` · ${first.title}` : ""}${rule.readOnly ? " · read-only" : ""}` }, ...rest],
  };
}

const location = (c: Crumb) => c.open?.garden ?? c.text;

function Crumbs({ paneId, parts, context }: { paneId: string; parts: NonNullable<ReturnType<typeof locationParts>>; context: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const least = useLeastWidth(ref);
  const { word, icon, badge } = planes[parts.plane];
  const switchable = parts.plane === "shoot" || parts.plane === "controlPlane";
  const color = planeColor[parts.plane];
  return (
    /*
      As wide as its texts while the header has room; short of it, it gives way before the header's other
      items, down to its parts' least (useLeastWidth), and clips besides, so nothing ever lands on what follows it.
      Inside, landscape and seed give way first, then the notes after the name, the name last, each down to a few
      letters; the badges, separators and the safety chip never.
    */
    <span
      ref={ref}
      aria-label="location"
      data-plane={parts.plane}
      title={`${parts.title}\ncontext: ${context}`}
      className="flex items-center gap-1 overflow-hidden whitespace-nowrap"
      style={{ flex: `0 ${shrinkFirst} auto`, minWidth: least.all ?? 0 }}
    >
      {/* landscape and seed in a box of their own, which alone shrinks while it can: they give way wholly before the name does */}
      {parts.before.length ? (
        <span data-least="row" className="flex items-center gap-1" style={{ flex: `0 ${shrinkFirst} auto`, minWidth: least.before ?? 0 }}>
          {parts.before.map((c, i) => (
            <span key={i} className="contents">
              <CrumbPart paneId={paneId} crumb={c} style={c.safety ? chip(c.safety, c.plain) : fit(c.text, beforeMin, 1)} />
              <span data-least="fixed" className="shrink-0 text-fg-muted">
                ›
              </span>
            </span>
          ))}
        </span>
      ) : null}
      <button
        type="button"
        data-least="fixed"
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
        <span data-least="text" className="truncate font-semibold" style={{ color, ...fit(parts.name, nameMin, 1) }}>
          {parts.name}
        </span>
      ) : null}
      {parts.after.map((c, i) => (
        <CrumbPart key={i} paneId={paneId} crumb={c} style={fit(c.text, afterMin, shrinkNext)} />
      ))}
    </span>
  );
}

/**
 * The breadcrumb's least width: what its parts can't give up, as the browser
 * lays them out. A text (data-least="text") its min-width, anything fixed
 * (data-least="fixed": badges, separators, the safety chip) its width, and
 * the gaps between all of them. Not the browser's min-content, which counts a
 * truncating text in full (the breadcrumb couldn't shrink), nor counted
 * letters (they came out short of badges' borders and glyphs, and the parts
 * spilled over what follows). Measured again whenever a part's size changes,
 * never while hidden (a background tab: no width at all).
 */
function useLeastWidth(ref: RefObject<HTMLSpanElement | null>): { all?: number; before?: number } {
  const [least, setLeast] = useState<{ all?: number; before?: number }>({});
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // a row's least: its parts' (a row inside it counts as one part) and the gaps between them
    const row = (r: HTMLElement): number => {
      const parts = [...r.querySelectorAll<HTMLElement>("[data-least]")].filter((p) => p.parentElement?.closest("[data-least=row]") === (r.dataset.least === "row" ? r : null));
      const gap = parseFloat(getComputedStyle(r).columnGap) || 0;
      let w = Math.max(0, parts.length - 1) * gap;
      for (const p of parts) w += p.dataset.least === "row" ? row(p) : p.dataset.least === "text" ? parseFloat(getComputedStyle(p).minWidth) || 0 : p.getBoundingClientRect().width;
      return w;
    };
    const measure = () => {
      if (el.getClientRects().length === 0) return; // hidden: keep the last
      const box = el.querySelector<HTMLElement>(":scope > [data-least=row]");
      const all = Math.ceil(row(el));
      const before = box ? Math.ceil(row(box)) : undefined;
      setLeast((old) => (old.all === all && old.before === before ? old : { all, before }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const p of el.querySelectorAll("[data-least]")) ro.observe(p);
    return () => ro.disconnect();
  });
  return least;
}

/**
 * Who gives way first, as flex-shrink weights (shares of the shortage, in
 * proportion to weight × width): in the header the breadcrumb before the
 * filter fields (weight 1); in it the landscape and seed box by far, then the
 * notes after the name, the name last. Whole numbers: weights that add up to
 * less than 1 shrink by that fraction of the shortage only.
 */
const shrinkFirst = 1000;
const shrinkNext = 30;

const beforeMin = 4;
const nameMin = 6;
const afterMin = 3;
const least = (text: string, min: number) => Math.min(min, text.length);

/**
 * A text that gives way to an ellipsis: as wide as its text while there's
 * room, shrinking by shrink, never below min letters (the font is monospace).
 */
const fit = (text: string, min: number, shrink: number): CSSProperties => ({
  flex: `0 ${shrink} auto`,
  minWidth: `${least(text, min)}ch`,
});

/** A safety label chip's look (see SafetyLabel), whole: it's the label, not a name to cut short. Plain: its text in the color alone. */
function chip(rule: SafetyRule, plain?: boolean): CSSProperties {
  const color = ruleColor(rule) ?? "var(--color-accent)";
  if (plain) return { flex: "none", color };
  return { flex: "none", color, borderColor: color, background: `color-mix(in srgb, ${color} 16%, transparent)` };
}

function CrumbPart({ paneId, crumb, style }: { paneId: string; crumb: Crumb; style: CSSProperties }) {
  const target = crumb.open;
  const safety = crumb.safety ? `${crumb.plain ? "" : "border px-1.5 "}leading-4 font-semibold hover:brightness-125` : "";
  if (!target)
    return (
      <span data-least={crumb.safety ? "fixed" : "text"} aria-label={crumb.safety ? "context label" : undefined} title={crumb.title} className={crumb.safety ? safety : `truncate ${crumb.muted ? "text-fg-muted" : ""}`} style={style}>
        {crumb.text}
      </span>
    );
  return (
    <button
      type="button"
      data-least={crumb.safety ? "fixed" : "text"}
      title={crumb.title}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void openTarget(paneId, { ...target, used: neverUsed, from: "jump", rule: { context: "", confirm: [] } }, crumb.text)}
      aria-label={crumb.safety ? "context label" : undefined}
      className={crumb.safety ? safety : "truncate text-left text-fg-muted hover:text-fg hover:underline"}
    >
      {crumb.text}
    </button>
  );
}
