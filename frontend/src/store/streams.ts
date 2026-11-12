/**
 * Bookkeeping of the streams (shells, log tails, table panes) a pane moving
 * to another window takes along (see transfer.ts); kept apart so the store
 * can consult it without importing the transfer.
 */

/** Streams handed to another window: the store must not close them as their pane leaves. */
export const handedOff = new Set<string>();

/** Per session: the seq of the last event received here. */
const received = new Map<string, number>();
const waiters = new Map<string, { seq: number; done: () => void }[]>();

/** Notes an event of a session or log tail; called for every one. */
export function receivedSeq(id: string, seq: number | undefined) {
  if (seq === undefined) return;
  received.set(id, Math.max(received.get(id) ?? 0, seq));
  const ws = waiters.get(id);
  if (!ws) return;
  const left = ws.filter((w) => (seq >= w.seq ? (w.done(), false) : true));
  if (left.length) waiters.set(id, left);
  else waiters.delete(id);
}

/**
 * Resolves once the events up to seq arrived (or after timeout): a call's
 * reply and the window's events travel separately, so ones sent before a
 * move may still be on their way when Reassign returns.
 */
export function waitFor(id: string, seq: number, timeout = 2000): Promise<void> {
  if ((received.get(id) ?? 0) >= seq) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, timeout);
    const w = { seq, done: () => (clearTimeout(timer), resolve()) };
    waiters.set(id, [...(waiters.get(id) ?? []), w]);
  });
}

/** Forgets a stream's numbering (its pane closed or left). */
export function forgetSeq(id: string) {
  received.delete(id);
  waiters.delete(id);
}

/** Exits of sessions whose pane wasn't here yet (the shell ended right as it moved over). */
export const earlyExits = new Map<string, string>();
