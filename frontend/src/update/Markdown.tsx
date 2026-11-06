import { Fragment, type ReactNode } from "react";
import { marked } from "marked";

/** marked's tokens, as far as they are rendered here (its own types aren't installed). */
interface Token {
  type: string;
  raw: string;
  text?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | "";
  href?: string;
  title?: string | null;
  tokens?: Token[];
  items?: Token[];
  task?: boolean;
  checked?: boolean;
}

/** Text as written: marked entity-escapes `text` (&amp;), React escapes on its own. */
const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);

/** Markdown tokens (GitHub-flavored, as marked reads them). */
export function lex(md: string): Token[] {
  return marked.lexer(md, { gfm: true }) as unknown as Token[];
}

/**
 * Markdown as React elements: release notes, written in Changelog.md. Built
 * from marked's tokens, never as HTML: raw HTML in the text shows as text,
 * and a link only opens through onLink (which decides where it may go).
 */
export function Markdown({ text, onLink, resolve }: { text: string; onLink: (href: string) => void; resolve: (href: string) => string | undefined }) {
  return <>{blocks(lex(text), { onLink, resolve })}</>;
}

interface Ctx {
  onLink: (href: string) => void;
  resolve: (href: string) => string | undefined;
}

function blocks(ts: Token[], c: Ctx): ReactNode[] {
  return ts.map((t, i) => block(t, i, c));
}

function block(t: Token, key: number, c: Ctx): ReactNode {
  switch (t.type) {
    case "heading": {
      // the version heading is the dialog's (h3); a note's ### Added is below it
      const cls = t.depth! <= 3 ? "mt-2 mb-0.5 font-semibold text-accent" : "mt-1.5 font-semibold text-fg";
      return t.depth! <= 3 ? (
        <h4 key={key} className={cls}>
          {inline(t.tokens, c)}
        </h4>
      ) : (
        <h5 key={key} className={cls}>
          {inline(t.tokens, c)}
        </h5>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="my-1">
          {inline(t.tokens, c)}
        </p>
      );
    case "text":
      // a tight list item's text: inline tokens of its own
      return <Fragment key={key}>{t.tokens ? inline(t.tokens, c) : unescape(t.text ?? t.raw)}</Fragment>;
    case "list": {
      const items = (t.items ?? []).map((it, i) => (
        <li key={i} className="my-0.5">
          {it.task ? <input type="checkbox" disabled checked={!!it.checked} className="mr-1 align-middle" /> : null}
          {blocks(it.tokens ?? [], c)}
        </li>
      ));
      return t.ordered ? (
        <ol key={key} start={typeof t.start === "number" ? t.start : undefined} className="my-1 list-decimal pl-5">
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-1 list-disc pl-5">
          {items}
        </ul>
      );
    }
    case "code":
      return (
        <pre key={key} className="my-1 overflow-x-auto rounded bg-bg px-2 py-1 text-fg select-text">
          <code>{t.text}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote key={key} className="my-1 border-l-2 border-border pl-2 text-fg-muted">
          {blocks(t.tokens ?? [], c)}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="my-2 border-border" />;
    case "space":
      return null;
    default:
      // tables, raw HTML blocks…: as written
      return (
        <p key={key} className="my-1 whitespace-pre-wrap">
          {t.raw.trim()}
        </p>
      );
  }
}

function inline(ts: Token[] | undefined, c: Ctx): ReactNode[] {
  return (ts ?? []).map((t, i) => span(t, i, c));
}

function span(t: Token, key: number, c: Ctx): ReactNode {
  switch (t.type) {
    case "text":
      return <Fragment key={key}>{t.tokens ? inline(t.tokens, c) : unescape(t.text ?? t.raw)}</Fragment>;
    case "escape":
      return <Fragment key={key}>{unescape(t.text ?? "")}</Fragment>;
    case "strong":
      return (
        <strong key={key} className="font-semibold text-fg">
          {inline(t.tokens, c)}
        </strong>
      );
    case "em":
      return (
        <em key={key} className="italic">
          {inline(t.tokens, c)}
        </em>
      );
    case "del":
      return (
        <del key={key} className="line-through">
          {inline(t.tokens, c)}
        </del>
      );
    case "codespan":
      return (
        <code key={key} className="rounded bg-bg px-1 text-fg">
          {unescape(t.text ?? "")}
        </code>
      );
    case "br":
      return <br key={key} />;
    case "link": {
      const to = c.resolve(t.href ?? "");
      if (!to) return <Fragment key={key}>{inline(t.tokens, c)}</Fragment>;
      return (
        <a
          key={key}
          href={to}
          title={to}
          className="text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
          onClick={(e) => {
            // never in the app's own webview: it would navigate away from kubewing
            e.preventDefault();
            c.onLink(to);
          }}
        >
          {inline(t.tokens, c)}
        </a>
      );
    }
    case "image":
      // no remote images in the app: the alt text, linked
      return span({ ...t, type: "link", tokens: [{ type: "text", raw: t.text ?? "", text: t.text ?? "image" }] }, key, c);
    default:
      // raw inline HTML (<x>) and anything unknown: as written
      return <Fragment key={key}>{t.raw}</Fragment>;
  }
}
