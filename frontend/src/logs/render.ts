/**
 * Turns buffered log lines into xterm-writable strings: a colored pod/container
 * prefix, an optional timestamp, the text with the live filter's positive
 * terms highlighted. Pure, so it is unit-tested without a terminal.
 */
import type { LogLine, LogStream } from "../transport/types";
import { grepRanges, matchGrep, parseGrep, type GrepTerm } from "../components/grep";

/** xterm's 16-color ANSI palette indices a pod's color cycles through (see logs.palette). */
const POD_COLORS = [2, 4, 5, 6, 3, 1]; // green, blue, magenta, cyan, yellow, red

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
/** Inverse video for a match highlight (uses the theme's colors, not a fixed one). */
const MATCH = "\x1b[7m";

function fg(ansi: number): string {
  return ansi < 8 ? `\x1b[3${ansi}m` : `\x1b[9${ansi - 8}m`;
}

/** Keeps a line only if its parts (pod, container, text: see lineParts) match
 * the terms, so typing a pod or container narrows to it and `^` anchors to
 * any of them. */
export function lineMatches(parts: string[], terms: GrepTerm[]): boolean {
  return matchGrep(terms, parts);
}

/** Highlights the positive terms in text with inverse video (case-insensitive;
 * an anchored term where it's anchored in the text). */
export function highlight(text: string, terms: GrepTerm[]): string {
  const ranges = grepRanges([text], terms)[0]!;
  if (ranges.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [s, e] of ranges) {
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

/** Widest the prefix column gets; longer labels are cut in the middle. */
export const MAX_PREFIX_WIDTH = 40;

/** What the live filter matches of a line: its pod, container (unless the
 * same as the pod) and text, or the stream id for an unknown stream. */
export function lineParts(s: LogStream | undefined, stream: string, text: string): string[] {
  if (!s) return [stream, text];
  return s.pod === s.container ? [s.pod, text] : [s.pod, s.container, text];
}

/**
 * The prefix per stream: only what tells the streams apart. One pod: its
 * containers; one container name: the pods; one of each: no prefix at all.
 * width fits the longest (at most MAX_PREFIX_WIDTH), 0 = no prefix column.
 */
export function streamLabels(streams: LogStream[]): { labels: Map<string, string>; width: number } {
  const pods = new Set(streams.map((s) => `${s.namespace}/${s.pod}`));
  const containers = new Set(streams.map((s) => s.container));
  const labels = new Map<string, string>();
  let width = 0;
  for (const s of streams) {
    const label =
      pods.size <= 1 && containers.size <= 1 ? "" : pods.size <= 1 ? s.container : containers.size <= 1 || s.pod === s.container ? s.pod : `${s.pod}/${s.container}`;
    labels.set(s.id, label);
    width = Math.max(width, label.length);
  }
  return { labels, width: Math.min(width, MAX_PREFIX_WIDTH) };
}

/**
 * Fits a label to width: padded, or cut in the middle with "…" when longer.
 * The end keeps the larger part: names of one pod's or workload's streams
 * share their start and differ at the end (etcd-main-0 … etcd-main-backup-restore).
 */
export function fitLabel(label: string, width: number): string {
  if (label.length <= width) return label.padEnd(width);
  const head = Math.floor((width - 1) / 3);
  return label.slice(0, head) + "…" + label.slice(label.length - (width - 1 - head));
}

/**
 * Renders the matching lines to xterm CRLF-terminated strings. A marker line
 * (no timestamp, bracketed "— … —") is shown dimmed and never filtered out,
 * so "stream ended" / "reconnecting" stay visible.
 */
export function renderLines(lines: LogLine[], o: RenderOptions): string[] {
  const byId = new Map(o.streams.map((s) => [s.id, s]));
  const { labels, width } = streamLabels(o.streams);
  const out: string[] = [];
  for (const l of lines) {
    const s = byId.get(l.stream);
    const marker = l.text.startsWith("—");
    // the filter matches the full pod and container, also where the prefix leaves them out
    if (!marker && !lineMatches(lineParts(s, l.stream, l.text), o.terms)) continue;
    let line = "";
    if (o.prefix && !marker && width > 0) {
      const color = s ? POD_COLORS[s.color % POD_COLORS.length]! : 7;
      line += fg(color) + fitLabel(s ? (labels.get(s.id) ?? "") : l.stream, width) + RESET + " ";
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
