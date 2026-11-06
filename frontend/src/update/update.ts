/**
 * The update check's UI state and pure helpers: when the hint shows, what
 * the dialog says, where release-note links go. Go decides what's offered
 * (internal/update); this only presents it.
 */
import { create } from "zustand";
import type { UpdateStatus } from "../transport/types";

/** The updater's state, pushed by Go (kw:update) on every change. */
export const useUpdate = create<{ status?: UpdateStatus }>(() => ({}));

/** The offer for the tab bar's hint: a new version not skipped (the dialog still shows a skipped one). */
export function hint(s: UpdateStatus | undefined) {
  const o = s?.offer;
  if (!o || o.version === s.skipped) return undefined;
  return o;
}

/** The dialog's state line. */
export function summary(s: UpdateStatus | undefined): string {
  if (!s) return "";
  if (s.installing) return phaseText(s.installing, s.progress);
  if (s.checking) return "checking for updates…";
  if (s.offer) return `kubewing ${s.offer.version} is available, you have ${s.current}`;
  if (s.error) return "";
  if (!s.released) return `${s.current} is a development build: it isn't updated`;
  if (s.lastCheck) return `kubewing ${s.current} is up to date`;
  return "";
}

export function phaseText(phase: NonNullable<UpdateStatus["installing"]>, progress = 0): string {
  switch (phase) {
    case "download":
      return `downloading… ${Math.floor(progress * 100)}%`;
    case "verify":
      return "verifying the download…";
    case "install":
      return "installing…";
    case "restart":
      return "restarting…";
  }
}

/** The automatic check's schedule, for the dialog's footer. */
export function scheduleText(days: number): string {
  if (days <= 0) return "automatic checks are off (update.checkDays: 0)";
  return days === 1 ? "checks daily (update.checkDays)" : `checks every ${days} days (update.checkDays)`;
}

/** How many sessions a restart ends, as the confirmation says it. */
export function restartWarning(sessions: number, forwards: number): string {
  const parts: string[] = [];
  if (sessions) parts.push(`${sessions} terminal or log ${sessions === 1 ? "pane" : "panes"}`);
  if (forwards) parts.push(`${forwards} port-${forwards === 1 ? "forward" : "forwards"}`);
  return parts.length ? `restarting ends ${parts.join(" and ")}` : "kubewing restarts; your panes open again as at a fresh start";
}

export function megabytes(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1e6).toFixed(0)} MB` : "";
}

const repo = "https://github.com/dguendisch/kubewing";

/**
 * A release-notes link as the browser should open it, or undefined if it
 * shouldn't be a link: relative links (Manual.md#x) point into the repository
 * at the released version, anchors to its README; only http(s) leaves the app.
 */
export function resolveLink(href: string, version: string): string | undefined {
  const h = href.trim();
  if (!h) return undefined;
  if (/^https?:\/\//i.test(h)) return h;
  // another scheme (javascript:, file:, mailto:…) is never followed
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return undefined;
  const ref = `v${version}`;
  if (h.startsWith("#")) return `${repo}/blob/${ref}/README.md${h}`;
  const path = h.replace(/^\.?\//, "");
  return `${repo}/blob/${ref}/${path}`;
}
