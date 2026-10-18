/**
 * Terminal session output, outside React (high-frequency, like pane frames):
 * the bridge pushes chunks, terminals write them straight into xterm.
 * Output before a terminal attaches is buffered (bounded) so nothing is lost
 * between starting a session and mounting its pane.
 */
type Listener = (chunk: Uint8Array | { exit: number | string }) => void;

const MAX_BUFFER = 256 * 1024;

class Sessions {
  private listeners = new Map<string, Listener>();
  private pending = new Map<string, (Uint8Array | { exit: number | string })[]>();
  private sizes = new Map<string, number>();

  push(id: string, chunk: Uint8Array | { exit: number | string }) {
    const l = this.listeners.get(id);
    if (l) return l(chunk);
    const buf = this.pending.get(id) ?? [];
    buf.push(chunk);
    let size = (this.sizes.get(id) ?? 0) + (chunk instanceof Uint8Array ? chunk.length : 0);
    while (size > MAX_BUFFER && buf.length > 1) {
      const first = buf.shift()!;
      if (first instanceof Uint8Array) size -= first.length;
    }
    this.pending.set(id, buf);
    this.sizes.set(id, size);
  }

  /** Attaches the terminal for a session; replays buffered output first. */
  attach(id: string, l: Listener): () => void {
    for (const c of this.pending.get(id) ?? []) l(c);
    this.pending.delete(id);
    this.sizes.delete(id);
    this.listeners.set(id, l);
    return () => {
      if (this.listeners.get(id) === l) this.listeners.delete(id);
    };
  }

  drop(id: string) {
    this.listeners.delete(id);
    this.pending.delete(id);
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
