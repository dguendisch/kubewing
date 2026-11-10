import { Component, useState, type ReactNode } from "react";
import { bridge } from "../store/store";

/**
 * Catches a render error below it: an uncaught one would unmount the whole
 * app and leave a blank window. In its place it shows the error and its
 * component stack, selectable, with "copy" and "retry" (renders the children
 * again; the store kept their state). Around each pane, so one pane's bug
 * leaves the others, their watches and shells running; around the app as
 * the last resort.
 */
export class Crashed extends Component<{ what: string; children: ReactNode }, { error?: unknown; stack?: string }> {
  state: { error?: unknown; stack?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    this.setState({ stack: info.componentStack ?? undefined });
    console.error(`kubewing: ${this.props.what} crashed`, error);
  }

  render() {
    if (this.state.error === undefined) return this.props.children;
    return <Report what={this.props.what} error={this.state.error} stack={this.state.stack} retry={() => this.setState({ error: undefined, stack: undefined })} />;
  }
}

function Report({ what, error, stack, retry }: { what: string; error: unknown; stack?: string; retry: () => void }) {
  const [copied, setCopied] = useState(false);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const text = [message, error instanceof Error ? error.stack : undefined, stack && `component stack:${stack}`].filter(Boolean).join("\n\n");
  return (
    <div role="alert" aria-label={`${what} crashed`} className="flex h-full min-h-0 w-full flex-col gap-2 overflow-hidden bg-bg p-3 text-fg">
      <div className="flex items-center gap-3">
        <span className="text-deleted">{what} crashed: a bug in kubewing</span>
        <button type="button" className="rounded border border-border px-2 text-fg-muted hover:text-fg" onClick={retry}>
          retry
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 text-fg-muted hover:text-fg"
          onClick={() => void bridge().copyText(text).then(() => setCopied(true), () => {})}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap text-small text-fg-muted select-text">{text}</pre>
    </div>
  );
}
