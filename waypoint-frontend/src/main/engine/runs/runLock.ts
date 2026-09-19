import { isBusy, serializeBy } from './keyedQueue';

/**
 * ROAD-XXX (resume dead sessions): one run's revive-and-start is
 * serialized against every other revive-and-start for that SAME run —
 * the button's explicit Resume (runsIpc.ts) and a transparent
 * resume-on-message (sendPrompt.ts) must share this lock, or both can
 * read the run as dead and both call `daemon.startSession` for it in the
 * narrow window between `reopenRun`'s ledger commit and the daemon call.
 *
 * This is NOT what prevents two dispatches from writing two runs on one
 * ticket — that is `dispatch.ts`'s own per-TICKET lock, a different
 * invariant (many runs, one ticket) enforced a different way (plus, for
 * the cross-process case neither lock can reach, a DB constraint — see
 * `agent_runs_one_live_writer_per_ticket`). This lock's invariant is
 * narrower: one run, one revive at a time. Not reentrant, and never held
 * at the same time as the per-ticket lock — nothing here needs both, and
 * nesting a non-reentrant queue inside itself deadlocks trivially, so
 * keep it that way.
 */
const runQueues = new Map<string, Promise<unknown>>();

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
