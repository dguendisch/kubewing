/**
 * Multi-pod log buffers, outside React (high-frequency, like term/sessions).
 * The bridge pushes line batches and stream-set changes per session; a log
 * pane keeps a bounded ring of lines so the live filter and the timestamp
 * toggle can re-render from it, and so a pane that remounts (StrictMode, a
 * pane moving) shows the same backlog instead of an empty screen.
 */
import type { LogLine, LogStream } from "../transport/types";

/** Default lines kept per log pane, as config.DefaultLogBuffer. */
export const DEFAULT_LOG_BUFFER = 50_000;

type Listener = () => void;

interface Buf {
  lines: LogLine[];
  streams: LogStream[];
  dropped: number;
  /** Sequence bumped on every change, so a pane knows to re-render. */
  seq: number;
}

class LogBuffers {
  private bufs = new Map<string, Buf>();
  private listeners = new Map<string, Set<Listener>>();
  private max = DEFAULT_LOG_BUFFER;

  setMax(lines: number) {
    this.max = Math.max(1, lines);
  }

  maxLines(): number {
    return this.max;
  }

  private buf(id: string): Buf {
    let b = this.bufs.get(id);
    if (!b) {
      b = { lines: [], streams: [], dropped: 0, seq: 0 };
      this.bufs.set(id, b);
    }
    return b;
  }

  /** Appends a batch of lines, drops the oldest beyond the cap. */
  pushLines(id: string, lines: LogLine[], dropped = 0) {
    const b = this.buf(id);
    b.lines.push(...lines);
    if (b.lines.length > this.max) b.lines.splice(0, b.lines.length - this.max);
    b.dropped += dropped;
    b.seq++;
    this.emit(id);
  }

  /** Replaces the stream set (Go sends the whole set on every change). */
  setStreams(id: string, streams: LogStream[]) {
    const b = this.buf(id);
    b.streams = streams;
    b.seq++;
    this.emit(id);
  }

  /** Clears the lines (⌘K), keeping the streams. */
  clear(id: string) {
    const b = this.buf(id);
    b.lines = [];
    b.dropped = 0;
    b.seq++;
    this.emit(id);
  }

  get(id: string): Buf {
    return this.buf(id);
  }

  subscribe(id: string, l: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(l);
    return () => set!.delete(l);
  }

  private emit(id: string) {
    this.listeners.get(id)?.forEach((l) => l());
  }

  /** Forgets a session (its pane is gone). */
  drop(id: string) {
    this.bufs.delete(id);
    this.listeners.delete(id);
  }
}

export const logBuffers = new LogBuffers();
