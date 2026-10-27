import { useSyncExternalStore } from "react";
import { logBuffers } from "./buffer";
import { filterTerms, lineMatches } from "./render";

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

/** Subscribes a log pane's header to its buffer's counts. */
export function useLogStatus(session: string, filter: string): LogStatus {
  const snap = useSyncExternalStore(
    (cb) => logBuffers.subscribe(session, cb),
    () => logBuffers.get(session).seq,
  );
  void snap; // the seq only triggers recompute; the values come from the buffer
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
    const label = s ? (s.pod === s.container ? s.pod : `${s.pod}/${s.container}`) : l.stream;
    if (lineMatches(`${label} ${l.text}`, terms)) shown++;
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
