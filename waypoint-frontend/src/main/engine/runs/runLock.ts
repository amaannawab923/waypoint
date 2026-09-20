import { isBusy, serializeBy } from './keyedQueue';

/**
 * One run's revive-and-start is serialized against every other
 * revive-and-start for that SAME run — the explicit Resume (runsIpc.ts),
 * a send (sendPrompt.ts), the pane's warm-up on open (warm.ts) and an
 * outbox drain must share this lock, or two of them can read the run as
 * not live and both call `daemon.startSession` for it in the narrow
 * window between `reopenRun`'s ledger commit and the daemon call.
 *
 * This is NOT what keeps a ticket to one automatic dispatch — that is
 * `dispatch.ts`'s own per-TICKET lock and the backend's advisory lock in
 * createRun, a different invariant enforced a different way. This lock's
 * invariant is narrower: one run, one revive at a time — and, since
 * round 5 of review, one run's first start too (startRun.ts's
 * continueStart), so reconcile's interrupt cannot land on a run mid-
 * provisioning. Not reentrant, and never AWAITED while the per-ticket
 * lock is held: dispatch.ts fires continueStart without awaiting it from
 * inside its ticket lock, which is fine — the queue only runs the body on
 * a later microtask, and no path holding this lock ever waits on the
 * ticket lock, so there is no cycle. Nesting a non-reentrant queue inside
 * itself deadlocks trivially, so keep it that way.
 */
const runQueues = new Map<string, Promise<unknown>>();

/**
 * Whether `runId`'s lock is held or queued right now — a synchronous
 * `Map.has`. sendPrompt.ts reads this with NO `await` between the read
 * and its own `withRunLock` call (design §2.5, A5): a send arriving while
 * a warm-up holds the lock goes to the outbox instead of waiting a cold
 * spawn out, and because `serializeBy` registers synchronously there is
 * no gap in which a warm-up could start between the check and the lock.
 */
export function isRunBusy(runId: string): boolean {
  return isBusy(runQueues, runId);
}

export function withRunLock<T>(
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return serializeBy(runQueues, runId, fn);
}

/**
 * A non-blocking variant: if `runId` already has a revive in flight
 * (queued or running under `withRunLock`), `fn` is never called and this
 * resolves to `{ acquired: false }` immediately — for reconcile's
 * kill-stale action, which must not stall the rest of its pass waiting
 * out someone else's resume it would rather just skip past (a live
 * session left alone is the safe failure there; reconcile gets another
 * pass). When the lock IS free, this registers in the exact same queue
 * `withRunLock` uses, so a `withRunLock` call arriving while this is
 * still running correctly queues behind it rather than racing it.
 */
export async function tryWithRunLock<T>(
  runId: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  if (isBusy(runQueues, runId)) return { acquired: false };
  const result = await serializeBy(runQueues, runId, fn);
  return { acquired: true, result };
}
