import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { bridge } from "../store/store";
import type { BlameOwner, BlameResult } from "../transport/types";

/** The widest a blame label gets (characters); longer manager names are cut with an ellipsis. */
export const blameMaxChars = 30;

/** How long ago, as kubectl's AGE column: 45s, 12m, 5h, 3d, 2y. Pure. */
export function age(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.floor(s / 60)}m`;
  if (s < 2 * 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 365 * 86400) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (365 * 86400))}y`;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A line's label in the gutter: its newest owner and how long ago it wrote, "+n" for the other owners. */
export function blameLabel(owners: BlameOwner[], now = Date.now()): string {
  const o = owners[0];
  if (!o) return "";
  const when = o.time ? ` ${age(o.time, now)}` : "";
  const more = owners.length > 1 ? ` +${owners.length - 1}` : "";
  const name = o.manager;
  const room = blameMaxChars - when.length - more.length;
  return (name.length > room ? `${name.slice(0, Math.max(1, room - 1))}…` : name) + more + when;
}

/** A line's tooltip: every owner, with operation, subresource and time. */
export function blameTitle(owners: BlameOwner[], now = Date.now()): string {
  return owners
    .map((o) => `${o.manager} (${o.operation}${o.subresource ? `, ${o.subresource}` : ""})${o.time ? ` · ${o.time} · ${age(o.time, now)} ago` : ""}`)
    .join("\n");
}

/** Per line (1-based), what the gutter shows; the width (characters) for the longest. */
export function blameColumn(r: BlameResult, now = Date.now()): { labels: Map<number, string>; titles: Map<number, string>; width: number } {
  const labels = new Map<number, string>();
  const titles = new Map<number, string>();
  let width = 8;
  for (const l of r.lines) {
    const label = blameLabel(l.owners, now);
    labels.set(l.line + 1, label);
    titles.set(l.line + 1, blameTitle(l.owners, now));
    width = Math.max(width, label.length);
  }
  // + the padding (see .kw-blame in theme.css), about two characters
  return { labels, titles, width: Math.min(width, blameMaxChars) + 2 };
}

/** A blame's outcome, for the view's header: the object has no managedFields, or why it failed. */
export type BlameState = { missing?: boolean; error?: string };

/** What the blame shows of a pane's object: which pane and row (Go reads its managedFields). */
export interface BlameOf {
  serverId: string;
  key: string;
}

/**
 * The blame in an editor's line-number gutter: each line's field manager
 * (and how long ago it wrote) in place of its number, dimmed, read-only like
 * the numbers. Asked from Go for each text shown; while the text doesn't
 * parse (the editor mid-typing) the labels are blank, the column as wide as
 * it was. Hovering a line's label lists all its owners.
 */
export function showBlame(ed: Monaco.editor.ICodeEditor, of: BlameOf, onState?: (s: BlameState) => void) {
  let gen = 0;
  let col: ReturnType<typeof blameColumn> | undefined;
  const dom = ed.getDomNode();
  const apply = () => {
    const c = col;
    ed.updateOptions({
      lineNumbers: c ? (n: number) => escape(c.labels.get(n) ?? "") : "on",
      lineNumbersMinChars: c ? c.width : 5,
    });
    dom?.classList.toggle("kw-blame", !!c);
  };
  const update = (text: string) => {
    const g = ++gen;
    void bridge()
      .blame(of.serverId, of.key, text)
      .then(
        (r) => {
          if (g !== gen) return;
          col = blameColumn(r);
          onState?.({ missing: r.missing });
          apply();
        },
        (e: Error) => {
          if (g !== gen) return;
          // YAML mid-typing: no owners until it parses again (the old ones would be on the wrong lines);
          // the column keeps its width, so the text doesn't shift while typing
          col = col && { labels: new Map(), titles: new Map(), width: col.width };
          onState?.({ error: e.message });
          apply();
        },
      );
  };
  // the owners of the hovered line, as a native tooltip (the hover contribution isn't loaded)
  const subs = [
    ed.onMouseMove((e) => {
      const margin = e.target.element?.closest(".line-numbers") as HTMLElement | null;
      if (!margin) return;
      const n = e.target.position?.lineNumber;
      margin.title = (n && col?.titles.get(n)) || "";
    }),
  ];
  return {
    update,
    dispose: () => {
      gen++;
      col = undefined;
      subs.forEach((d) => d.dispose());
      apply();
    },
  };
}
