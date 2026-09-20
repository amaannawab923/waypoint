import {
  MAX_FIRST_MESSAGE_CHARS,
  type PendingPromptReason,
  type SendRunPromptResult,
} from '../types';
import type { DaemonSessionSummary } from './daemonApi';
import { assertRunId, LedgerRequestError, type AgentRun } from './ledgerClient';
import {
  drain,
  enqueue,
  openRows,
  resetAutoAttempts,
  type DrainTrigger,
} from './outbox';
import { isRunBusy, withRunLock } from './runLock';
import {
  ENGINE_NOT_RUNNING,
  RESUMABLE_RUN_STATUSES,
  resumeRunCore,
  type StartRunDeps,
} from './startRun';
import { takeWarmed } from './warm';

export interface ValidatedSendPromptInput {
  runId: string;
  text: string;
}

export function validateSendPromptInput(
  input: unknown,
): ValidatedSendPromptInput {
  if (!input || typeof input !== 'object') throw new Error('Not a message.');
  const { runId, text } = input as Record<string, unknown>;
  if (typeof runId !== 'string') throw new Error('Not a run id.');
  assertRunId(runId);
  if (typeof text !== 'string') throw new Error('The message must be text.');
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('The message is empty.');
  if (trimmed.length > MAX_FIRST_MESSAGE_CHARS) {
    throw new Error(
      `The message can be at most ${MAX_FIRST_MESSAGE_CHARS} characters.`,
    );
  }
  return { runId, text: trimmed };
}

export interface SendPromptDeps extends StartRunDeps {
  /**
   * The current member, when main knows it; null when it does not (the
   * ledger's local mode carries no identity header, and the backend
   * treats every request from this process as the one local member).
   * When unknown, a run is taken to be the caller's until the backend's
   * reopen says otherwise — its "belongs to another member" 409 routes
   * the message to the outbox as `owner-offline` all the same.
   */
  currentMemberId?: () => string | null;
  /** A member's display name, for a teammate's message ("From <name> in Waypoint:"). */
  memberName?: (memberId: string) => string | null;
}

/** A live daemon session can take a prompt right now (idle or working). */
const LIVE = new Set(['running', 'blocked']);

async function outboxed(
  deps: SendPromptDeps,
  run: AgentRun,
  text: string,
  reason: PendingPromptReason,
): Promise<SendRunPromptResult> {
  const pending = await enqueue(deps, run.id, text, reason);
  return { outcome: 'outboxed', status: run.status, pending };
}

/**
 * Arrival order, decided synchronously at `sendRunPrompt`'s entry — a
 * ticket per send in this process. A row this process outboxed carries
 * its send's ticket; a send delivers the rows whose ticket is older than
 * its own (and any row from elsewhere — another process, a teammate —
 * which has none) before its own text, and the rest after.
 */
let arrivals = 0;
// Run-scoped on purpose (found in review): a flat `Map<pendingId,
// arrival>` pruned by "not in this run's open rows" would delete other
// runs' still-open entries too, since pending ids are opaque across
// runs. Nesting by runId keeps pruning correctly scoped to the one run
// a send is actually about, and lets a run whose outbox is empty drop
// its whole sub-map, not just its rows one at a time.
const arrivalOf = new Map<string, Map<string, number>>();

/** Exported alongside `waitingBefore` below: a direct, deterministic test seam over the module-private arrival table. */
export function recordArrival(
  runId: string,
  pendingId: string,
  arrival: number,
) {
  let byRun = arrivalOf.get(runId);
  if (!byRun) {
    byRun = new Map();
    arrivalOf.set(runId, byRun);
  }
  byRun.set(pendingId, arrival);
}

/** Test seam only: how many arrival entries a run is still carrying. */
export function arrivalEntriesForTests(runId: string): number {
  return arrivalOf.get(runId)?.size ?? 0;
}

export async function waitingBefore(
  deps: SendPromptDeps,
  runId: string,
  arrival: number,
): Promise<Set<string>> {
  const rows = openRows(
    await deps.ledger.listPendingPrompts(runId).catch(() => []),
  );
  const byRun = arrivalOf.get(runId);
  // An entry only ever needs to outlive its own row being open — once
  // delivered, dropped, or otherwise settled, nothing will compare
  // against it again. Pruned here, on every ordinary send for this run
  // (found in review: unbounded growth otherwise — one entry per
  // message ever outboxed via the busy path, for the process's whole
  // lifetime).
  if (byRun) {
    const open = new Set(rows.map((r) => r.id));
    [...byRun.keys()]
      .filter((id) => !open.has(id))
      .forEach((id) => byRun.delete(id));
    if (byRun.size === 0) arrivalOf.delete(runId);
  }
  return new Set(
    rows.filter((r) => (byRun?.get(r.id) ?? -1) < arrival).map((r) => r.id),
  );
}

/**
 * Deliver in arrival order around this send's own text: the rows that
 * were waiting when it began, then the text, then whatever arrived
 * meanwhile (a send outboxed while this one held the lock).
 */
async function deliverAround(
  deps: SendPromptDeps,
  daemon: NonNullable<ReturnType<SendPromptDeps['daemon']>>,
  run: AgentRun,
  text: string,
  older: ReadonlySet<string>,
  trigger: DrainTrigger,
  hiddenContext?: string,
): Promise<'delivered' | 'blocked'> {
  const before = await drain(deps, daemon, run, {
    trigger,
    hiddenContext,
    memberName: deps.memberName,
    only: older,
  });
  if (before.blockedBy) return 'blocked';
  await daemon.sendPrompt(
    run.id,
    text,
    before.delivered === 0 ? hiddenContext : undefined,
  );
  await drain(deps, daemon, run, { trigger, memberName: deps.memberName });
  return 'delivered';
}

async function recordSent(
  deps: SendPromptDeps,
  runId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await deps.ledger
    .appendEvent(runId, 'prompt_sent', {
      by: 'user',
      kind: 'message',
      ...extra,
    })
    .catch(() => {});
}

// The body of a send, run only once sendRunPrompt below has this run's
// lock — see sendRunPrompt's own doc comment for the externally-visible
// contract this implements.
async function sendRunPromptLocked(
  deps: SendPromptDeps,
  runId: string,
  text: string,
  trigger: DrainTrigger,
  arrival: number,
): Promise<SendRunPromptResult> {
  const run = await deps.ledger.getRun(runId);
  if (!run) throw new Error(`No run ${runId} in the ledger.`);
  const daemon = deps.daemon();
  if (!daemon) throw new Error(ENGINE_NOT_RUNNING);

  // A teammate's message: accepted for the owner's Waypoint to deliver
  // (design §3.6). The owner check on reopenRun is a physical fact — the
  // session runs on the owner's machine — not a lock.
  const me = deps.currentMemberId?.() ?? null;
  if (me !== null && run.ownerMemberId !== me) {
    return outboxed(deps, run, text, 'owner-offline');
  }

  // A person acted on this run: every automatic-attempt counter resets.
  await resetAutoAttempts(deps, runId).catch(() => {});
  const older = await waitingBefore(deps, runId, arrival);

  const sessions = await daemon
    .listSessions()
    .catch((): Record<string, DaemonSessionSummary> => ({}));
  const live = sessions[run.id];

  if (LIVE.has(run.status) && live) {
    // Rows already waiting first, then this message, then anything that
    // arrived meanwhile — the daemon queues behind a working turn on its
    // own (`placement: 'auto'`).
    const fate = await deliverAround(deps, daemon, run, text, older, trigger);
    // The session itself is live — not starting. Blocked by an earlier
    // row in this run's outbox still resolving (found in review: this
    // used to say 'starting', which is false once the session is up).
    if (fate === 'blocked')
      return outboxed(deps, run, text, 'blocked-by-earlier');
    await recordSent(deps, run.id);
    return {
      outcome: live.isGenerating ? 'queued' : 'sent',
      status: run.status,
    };
  }

  if (run.status === 'finishing') {
    // Finalize holds the row and is reading history; the message goes
    // next — REST/FILE drains the outbox as its last step (design §4.4).
    return outboxed(deps, run, text, 'finishing');
  }

  if (run.status === 'queued' || run.status === 'provisioning') {
    // A start is on its way: continueStart drains the outbox into the
    // session's initialQueue (design §2.4 trigger 1).
    return outboxed(deps, run, text, 'starting');
  }

  if (LIVE.has(run.status) && !live) {
    // The ledger says live but the daemon has no session (it died; the
    // follower has not yet written interrupted): resume, then send.
    // resumeRunCore answers already-live for a live status — so this is
    // the one place a live-status run is put through a start directly.
    try {
      const { sessionId } = await daemon.startSession({
        conversationId: run.id,
        providerId: run.providerId,
        cwd: run.cwd ?? run.worktreePath ?? '',
        sessionId: run.providerSessionId,
        modeId: run.modeId,
      });
      await deps.ledger
        .updateRun(run.id, { providerSessionId: sessionId })
        .catch(() => {});
    } catch {
      return outboxed(deps, run, text, 'spawn-failed');
    }
    const fate = await deliverAround(deps, daemon, run, text, older, trigger);
    // The session itself is live — not starting. Blocked by an earlier
    // row in this run's outbox still resolving (found in review: this
    // used to say 'starting', which is false once the session is up).
    if (fate === 'blocked')
      return outboxed(deps, run, text, 'blocked-by-earlier');
    await recordSent(deps, run.id);
    return { outcome: 'sent', status: run.status };
  }

  if (!RESUMABLE_RUN_STATUSES.includes(run.status)) {
    // Every status is either live, on its way, finishing, or resumable
    // — this is unreachable; kept as the honest fallback.
    return outboxed(deps, run, text, 'starting');
  }

  // Not live. A session the pane already warmed (warm.ts) — or one that
  // finalize left alive — is `continued`: reopen and hand over in one
  // step, no spawn. Otherwise resume (recreating the worktree if it must),
  // then hand over.
  const warmed = takeWarmed(run.id);
  const alive = live
    ? { sessionId: run.providerSessionId ?? run.id, loaded: true }
    : warmed;
  let resumed: Awaited<ReturnType<typeof resumeRunCore>>;
  try {
    resumed = await resumeRunCore(
      deps,
      runId,
      warmed || live ? 'open-then-message' : 'message',
      alive,
    );
  } catch (error) {
    if (
      error instanceof LedgerRequestError &&
      error.status === 409 &&
      /another member/.test(error.message)
    ) {
      return outboxed(deps, run, text, 'owner-offline');
    }
    throw error;
  }
  switch (resumed.outcome) {
    case 'cannot-reach-worktree':
      return outboxed(deps, run, text, resumed.reason ?? 'repository-missing');
    case 'spawn-failed':
      return outboxed(deps, run, text, 'spawn-failed');
    case 'cancelled-mid-resume':
      return { outcome: 'cancelled-mid-resume', status: resumed.status };
    case 'already-live':
      // A concurrent path revived it between our read and the reopen:
      // send to the live session.
      await daemon.sendPrompt(run.id, text);
      await recordSent(deps, run.id);
      return { outcome: 'sent', status: resumed.status };
    default:
  }
  // loaded / replaced-by-new: the note(s) ride on the first prompt
  // delivered — a pending row if there is one, else this message.
  const { hiddenContext } = resumed;
  const after = (await deps.ledger.getRun(run.id)) ?? run;
  const fate = await deliverAround(
    deps,
    daemon,
    after,
    text,
    older,
    trigger,
    hiddenContext,
  );
  // Just resumed/loaded — not starting either. Blocked by an earlier row
  // in this run's outbox still resolving (found in review: this used to
  // say 'starting', which is false once the resume has already landed).
  if (fate === 'blocked')
    return outboxed(deps, run, text, 'blocked-by-earlier');
  // No spawn happened in this send: the session was alive, or the pane
  // had already warmed it — `continued`, not `resumed-and-sent`.
  const continued = alive !== null;
  await recordSent(deps, run.id, {
    afterResume: resumed.outcome,
    ...(continued ? { continued: true, from: run.status } : {}),
  });
  return {
    outcome: continued ? 'continued' : 'resumed-and-sent',
    status: 'running',
    resume: resumed.outcome,
    ...(resumed.worktreeRecreated
      ? { worktreeRecreated: true, branchReused: resumed.branchReused }
      : {}),
  };
}

/**
 * Deliver the run's outbox if its session is live — the drain the
 * mount/focus/boot/finalize triggers and a busy send's follow-up use.
 * Under the run lock (the caller's). Nothing is started here; a run
 * whose session is not live keeps its rows for the next resume.
 */
export async function drainIfLive(
  deps: SendPromptDeps,
  runId: string,
  trigger: DrainTrigger = 'mount',
): Promise<void> {
  const run = await deps.ledger.getRun(runId);
  if (!run) return;
  const daemon = deps.daemon();
  if (!daemon) return;
  const sessions = await daemon
    .listSessions()
    .catch((): Record<string, DaemonSessionSummary> => ({}));
  if (!sessions[run.id]) return;
  if (!LIVE.has(run.status)) return;
  await drain(deps, daemon, run, { trigger, memberName: deps.memberName });
}

/**
 * Every send lands somewhere (never-lock, 2026-09-20, design §2.3). The
 * renderer's composer calls this for every message, whatever the run's
 * status. Live and idle → sent; live and working → the daemon queues it;
 * finished with its session still alive (or warmed on open) → continued
 * in one step; not live → resumed (worktree recreated if it must be),
 * then sent; a session still starting, finalize holding the row, a
 * worktree that cannot be reached right now, a spawn that failed, or a
 * teammate's message for the owner's machine → accepted into the run's
 * outbox and delivered when it can be. The one send that hands the text
 * back is `cancelled-mid-resume`: the person's own Stop overriding their
 * own message.
 *
 * Resolves at acceptance, not turn end — `DaemonRunsApi.sendPrompt`
 * races the daemon's turn-end answer against PROMPT_ACCEPTED_MS — so the
 * composer clears the text within ~2 s and never greys out for a turn.
 *
 * The busy check runs with NO `await` between it and the lock (design
 * §2.5, A5): a send arriving while a warm-up or another send holds the
 * lock is outboxed straight away and delivered by a drain queued behind
 * whatever holds it, rather than waiting a cold spawn out.
 */
export function sendRunPrompt(
  deps: SendPromptDeps,
  rawInput: unknown,
): Promise<SendRunPromptResult> {
  const { runId, text } = validateSendPromptInput(rawInput); // sync
  const arrival = arrivals; // sync: this send's place in arrival order
  arrivals += 1;
  if (isRunBusy(runId)) {
    // sync — nothing may await between the check above and the lock below
    return (async () => {
      const run = await deps.ledger.getRun(runId);
      if (!run) throw new Error(`No run ${runId} in the ledger.`);
      const pending = await enqueue(deps, runId, text, 'starting');
      recordArrival(runId, pending.id, arrival);
      // Delivered as soon as whatever holds the lock lets go.
      withRunLock(runId, () => drainIfLive(deps, runId)).catch(
        (error: unknown) =>
          deps.logger.warn('engine: outbox drain after busy send failed', {
            runId,
            message: error instanceof Error ? error.message : String(error),
          }),
      );
      return { outcome: 'outboxed', status: run.status, pending };
    })();
  }
  return withRunLock(runId, () =>
    sendRunPromptLocked(deps, runId, text, 'send', arrival),
  );
}

/**
 * Finalize's last step (design §4.4): a message typed while finalize
 * held the row (`finishing`) is delivered now. The run has just been
 * written done/needs-review and its session is still alive, so this is
 * the `continued` path — reopen, `running`, deliver — and the follower's
 * next idle edge finalizes again. Under the run lock; no-op without
 * open rows.
 */
export function deliverPendingAfterFinalize(
  deps: SendPromptDeps,
  runId: string,
): Promise<void> {
  return withRunLock(runId, async () => {
    const rows = openRows(await deps.ledger.listPendingPrompts(runId));
    if (rows.length === 0) return;
    const run = await deps.ledger.getRun(runId);
    if (!run) return;
    const daemon = deps.daemon();
    if (!daemon) return;
    const sessions = await daemon
      .listSessions()
      .catch((): Record<string, DaemonSessionSummary> => ({}));
    const live = sessions[run.id];
    if (LIVE.has(run.status) && live) {
      await drain(deps, daemon, run, {
        trigger: 'finalize',
        memberName: deps.memberName,
      });
      return;
    }
    if (!RESUMABLE_RUN_STATUSES.includes(run.status)) return;
    const resumed = await resumeRunCore(
      deps,
      runId,
      'message',
      live
        ? { sessionId: run.providerSessionId ?? run.id, loaded: true }
        : takeWarmed(runId),
    );
    if (resumed.outcome !== 'loaded' && resumed.outcome !== 'replaced-by-new')
      return;
    const after = await deps.ledger.getRun(runId);
    await drain(deps, daemon, after ?? run, {
      trigger: 'finalize',
      hiddenContext: resumed.hiddenContext,
      memberName: deps.memberName,
    });
  });
}

/** The person's Retry on a pending row: reset its counter and drain now, resuming if the run is not live. */
export function retryPendingPrompt(
  deps: SendPromptDeps,
  rawInput: unknown,
): Promise<SendRunPromptResult> {
  if (!rawInput || typeof rawInput !== 'object')
    throw new Error('Not a retry.');
  const { runId } = rawInput as Record<string, unknown>;
  if (typeof runId !== 'string') throw new Error('Not a run id.');
  assertRunId(runId);
  return withRunLock(runId, async () => {
    await resetAutoAttempts(deps, runId);
    const run = await deps.ledger.getRun(runId);
    if (!run) throw new Error(`No run ${runId} in the ledger.`);
    const daemon = deps.daemon();
    if (!daemon) throw new Error(ENGINE_NOT_RUNNING);
    const sessions = await daemon
      .listSessions()
      .catch((): Record<string, DaemonSessionSummary> => ({}));
    if (sessions[run.id] && LIVE.has(run.status)) {
      const drained = await drain(deps, daemon, run, {
        trigger: 'retry',
        memberName: deps.memberName,
      });
      return {
        outcome: drained.blockedBy ? 'outboxed' : 'sent',
        status: run.status,
      };
    }
    if (!RESUMABLE_RUN_STATUSES.includes(run.status)) {
      return { outcome: 'outboxed', status: run.status };
    }
    const resumed = await resumeRunCore(
      deps,
      runId,
      'message',
      takeWarmed(runId),
    );
    if (resumed.outcome === 'loaded' || resumed.outcome === 'replaced-by-new') {
      const after = await deps.ledger.getRun(runId);
      const drained = await drain(deps, daemon, after ?? run, {
        trigger: 'retry',
        hiddenContext: resumed.hiddenContext,
        memberName: deps.memberName,
      });
      return {
        outcome: drained.blockedBy ? 'outboxed' : 'resumed-and-sent',
        status: 'running',
        resume: resumed.outcome,
      };
    }
    return { outcome: 'outboxed', status: resumed.status };
  });
}

/** The person drops a pending row. */
export async function dropPendingPrompt(
  deps: SendPromptDeps,
  rawInput: unknown,
): Promise<void> {
  if (!rawInput || typeof rawInput !== 'object') throw new Error('Not a drop.');
  const { runId, pendingId } = rawInput as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof pendingId !== 'string')
    throw new Error('Not a run id.');
  assertRunId(runId);
  assertRunId(pendingId);
  await deps.ledger.updatePendingPrompt(runId, pendingId, { state: 'dropped' });
}
