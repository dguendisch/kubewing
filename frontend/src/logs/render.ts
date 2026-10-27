/**
 * Turns buffered log lines into xterm-writable strings: a colored pod/container
 * prefix, an optional timestamp, the text with the live filter's positive
 * terms highlighted. Pure, so it is unit-tested without a terminal.
 */
import type { LogLine, LogStream } from "../transport/types";
import { parseGrep, type GrepTerm } from "../components/grep";

/** xterm's 16-color ANSI palette indices a pod's color cycles through (see logs.palette). */
const POD_COLORS = [2, 4, 5, 6, 3, 1]; // green, blue, magenta, cyan, yellow, red

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
/** Inverse video for a match highlight (uses the theme's colors, not a fixed one). */
const MATCH = "\x1b[7m";

function fg(ansi: number): string {
  return ansi < 8 ? `\x1b[3${ansi}m` : `\x1b[9${ansi - 8}m`;
}

/** Keeps a line only if every positive term matches and no negated one does;
 * matched against "pod container text" so typing a pod or container narrows. */
export function lineMatches(haystack: string, terms: GrepTerm[]): boolean {
  const low = haystack.toLowerCase();
  for (const t of terms) {
    if (low.includes(t.text) === t.not) return false;
  }
  return true;
}

/** Highlights every positive term in text with inverse video (case-insensitive). */
export function highlight(text: string, terms: GrepTerm[]): string {
  const pos = terms.filter((t) => !t.not).map((t) => t.text).filter(Boolean);
  if (pos.length === 0) return text;
  const low = text.toLowerCase();
  // collect match ranges, merge overlaps
  const ranges: [number, number][] = [];
  for (const t of pos) {
    for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + 1)) ranges.push([i, i + t.length]);
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  let out = "";
  let at = 0;
  for (const [s, e] of merged) {
    out += text.slice(at, s) + MATCH + text.slice(s, e) + RESET;
    at = e;
  }
  return out + text.slice(at);
}

export interface RenderOptions {
  /** Prefix each line with its pod/container, colored per pod. */
  prefix: boolean;
  /** Show the RFC 3339 timestamp (dimmed). */
  timestamps: boolean;
  /** The live filter's parsed terms (positive highlighted, all applied). */
  terms: GrepTerm[];
  /** The stream set, to resolve a line's pod/container and color. */
  streams: LogStream[];
}

/** Width the prefix column is padded to, so texts line up. */
const PREFIX_WIDTH = 24;

/**
 * Renders the matching lines to xterm CRLF-terminated strings. A marker line
 * (no timestamp, bracketed "— … —") is shown dimmed and never filtered out,
 * so "stream ended" / "reconnecting" stay visible.
 */
export function renderLines(lines: LogLine[], o: RenderOptions): string[] {
  const byId = new Map(o.streams.map((s) => [s.id, s]));
  const out: string[] = [];
  for (const l of lines) {
    const s = byId.get(l.stream);
    const label = s ? (s.pod === s.container ? s.pod : `${s.pod}/${s.container}`) : l.stream;
    const marker = l.text.startsWith("—");
    const haystack = `${label} ${l.text}`;
    if (!marker && !lineMatches(haystack, o.terms)) continue;
    let line = "";
    if (o.prefix && !marker) {
      const color = s ? POD_COLORS[s.color % POD_COLORS.length]! : 7;
      const padded = label.length >= PREFIX_WIDTH ? label.slice(0, PREFIX_WIDTH - 1) + "…" : label.padEnd(PREFIX_WIDTH);
      line += fg(color) + padded + RESET + " ";
    }
    if (o.timestamps && l.ts) line += DIM + l.ts + RESET + " ";
    line += marker ? DIM + l.text + RESET : highlight(l.text, o.terms);
    out.push(line + "\r\n");
  }
  return out;
}

/** Convenience: parse a filter string into terms (empty string = no terms). */
export function filterTerms(filter: string): GrepTerm[] {
  return filter.trim() ? parseGrep(filter) : [];
}
