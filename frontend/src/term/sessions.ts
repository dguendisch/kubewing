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

const MAX_BUFFER = 256 * 1024;

class Sessions {
  private listeners = new Map<string, Listener>();
  private transcript = new Map<string, Chunk[]>();
  private sizes = new Map<string, number>();

  push(id: string, chunk: Chunk) {
    const buf = this.transcript.get(id) ?? [];
    buf.push(chunk);
    let size = (this.sizes.get(id) ?? 0) + (chunk instanceof Uint8Array ? chunk.length : 0);
    while (size > MAX_BUFFER && buf.length > 1) {
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
