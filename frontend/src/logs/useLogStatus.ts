import { useRef, useSyncExternalStore } from "react";
import { logBuffers } from "./buffer";
import { filterTerms, lineMatches, streamName } from "./render";

export interface LogStatus {
  /** Lines in the buffer (before the filter). */
  total: number;
  /** Lines the filter shows. */
  shown: number;
  /** Max lines the buffer keeps. */
  max: number;
  /** Lines dropped (batch overflow). */
  dropped: number;
  /** Streams being followed (not ended, not over the cap). */
  following: number;
  /** Distinct pods among the followed streams. */
  pods: number;
  /** Streams refused by the cap. */
  limited: number;
  /** Streams whose pod/container ended. */
  ended: number;
}

/**
 * Subscribes a log pane's header to its buffer's counts. The status is the
 * store snapshot itself (cached per seq and filter): the buffer is mutated in
 * place, so a value computed beside the hook would be memoized stale by the
 * React Compiler.
 */
export function useLogStatus(session: string, filter: string): LogStatus {
  const cache = useRef<{ session: string; seq: number; filter: string; status: LogStatus }>(undefined);
  return useSyncExternalStore(
    (cb) => logBuffers.subscribe(session, cb),
    () => {
      const seq = logBuffers.get(session).seq;
      const c = cache.current;
      if (c && c.session === session && c.seq === seq && c.filter === filter) return c.status;
      const status = logStatus(session, filter);
      cache.current = { session, seq, filter, status };
      return status;
    },
  );
}

function logStatus(session: string, filter: string): LogStatus {
  const b = logBuffers.get(session);
  const terms = filterTerms(filter);
  const byId = new Map(b.streams.map((s) => [s.id, s]));
  let shown = 0;
  for (const l of b.lines) {
    if (l.text.startsWith("—")) {
      shown++;
      continue;
    }
    const s = byId.get(l.stream);
    if (lineMatches(`${s ? streamName(s) : l.stream} ${l.text}`, terms)) shown++;
  }
  const pods = new Set<string>();
  let following = 0, limited = 0, ended = 0;
  for (const s of b.streams) {
    if (s.state === "following") {
      following++;
      pods.add(s.pod);
    } else if (s.state === "limited") limited++;
    else ended++;
  }
  return { total: b.lines.length, shown, max: logBuffers.maxLines(), dropped: b.dropped, following, pods: pods.size, limited, ended };
}
