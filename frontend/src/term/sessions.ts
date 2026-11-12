/**
 * Terminal session output, outside React (high-frequency, like pane frames):
 * the bridge pushes chunks, terminals write them straight into xterm.
 * Each session keeps a bounded transcript that every attach replays, so
 * nothing is lost between starting a session and mounting its pane, and a
 * terminal that mounts again (React StrictMode, a pane moving) shows the same
 * screen instead of an empty one.
 */
type Chunk = Uint8Array | { exit: number | string };
type Listener = (chunk: Chunk) => void;

/** Default terminal scrollback (lines), as config.DefaultScrollback. */
export const DEFAULT_SCROLLBACK = 10_000;

/** Bytes kept per scrollback line: generous for colored output (escape sequences). */
const BYTES_PER_LINE = 200;

class Sessions {
  private listeners = new Map<string, Listener>();
  private transcript = new Map<string, Chunk[]>();
  private sizes = new Map<string, number>();
  /** Transcript bound per session; follows the scrollback (setScrollback). */
  private max = DEFAULT_SCROLLBACK * BYTES_PER_LINE;

  /** The transcript holds about as much as the terminal's scrollback (config.yaml terminal.scrollback). */
  setScrollback(lines: number) {
    this.max = lines * BYTES_PER_LINE;
  }

  push(id: string, chunk: Chunk) {
    const buf = this.transcript.get(id) ?? [];
    buf.push(chunk);
    let size = (this.sizes.get(id) ?? 0) + (chunk instanceof Uint8Array ? chunk.length : 0);
    while (size > this.max && buf.length > 1) {
      const first = buf.shift()!;
      if (first instanceof Uint8Array) size -= first.length;
    }
    this.transcript.set(id, buf);
    this.sizes.set(id, size);
    this.listeners.get(id)?.(chunk);
  }

  /** Attaches the terminal for a session; replays the transcript first. */
  attach(id: string, l: Listener): () => void {
    for (const c of this.transcript.get(id) ?? []) l(c);
    this.listeners.set(id, l);
    return () => {
      if (this.listeners.get(id) === l) this.listeners.delete(id);
    };
  }

  /** Forgets a session (its pane is gone). */
  drop(id: string) {
    this.listeners.delete(id);
    this.transcript.delete(id);
    this.sizes.delete(id);
  }

  /** The transcript as it stands (a pane moving to another window takes it along). */
  snapshot(id: string): Chunk[] {
    return [...(this.transcript.get(id) ?? [])];
  }

  /**
   * A pane came from another window: its transcript there goes before what
   * already arrived here (after the move); trimmed to the bound like pushes.
   */
  prepend(id: string, chunks: Chunk[]) {
    const buf = [...chunks, ...(this.transcript.get(id) ?? [])];
    let size = buf.reduce((n, c) => n + (c instanceof Uint8Array ? c.length : 0), 0);
    while (size > this.max && buf.length > 1) {
      const first = buf.shift()!;
      if (first instanceof Uint8Array) size -= first.length;
    }
    this.transcript.set(id, buf);
    this.sizes.set(id, size);
  }
}

export const sessions = new Sessions();

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
