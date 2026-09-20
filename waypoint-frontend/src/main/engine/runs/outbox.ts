import type { PendingPrompt, PendingPromptReason } from '../types';
import type { DaemonRunsApi } from './daemonApi';
import type { AgentRun } from './ledgerClient';
import type { StartRunDeps } from './startRun';

/**
 * The per-run outbox, host side (never-lock, design §2.4). A message that
 * could not be handed to the daemon right now is a row in the ledger's
 * `agent_run_pending_prompts`, shown inline as pending, and delivered
 * from here — at most once — when it can be.
 *
 * At-most-once, by a claim: a row is moved to `sending` BEFORE the daemon
 * call and to `delivered` after it is accepted. A host that dies in
 * between leaves a row that says `sending`; the next drain resolves it
 * first — against the daemon's own queued prompts and recent history —
 * and only then sends anything newer. `sending`/`unresolved` rows block
 * the rows behind them (FIFO), so the drain itself can never produce a
 * duplicate. Chosen over at-least-once on purpose: a prompt delivered
 * twice to an agent that edits files is worse than one the person has
 * to Resend, and the `unresolved` row makes the latter visible.
 *
 * Every drain runs under the run's lock (runLock.ts) — the caller's job.
 * The daemon minted its own queue ids and takes no client id, so the
 * text itself is the identity the crash resolution compares.
 */

/** Automatic drains (mount, focus, boot, finalize) that may end `spawn-failed` for one row before it waits for the person. */
export const MAX_AUTO_ATTEMPTS = 3;
/** How many recent turns the crash resolution reads back. */
const RESOLVE_HISTORY_TURNS = 20;

export type DrainTrigger =
  'send' | 'retry' | 'mount' | 'focus' | 'boot' | 'finalize' | 'resume';

export interface OutboxDeps {
  ledger: StartRunDeps['ledger'];
  logger: StartRunDeps['logger'];
}

/** The rows a drain may still act on, oldest first. */
export function openRows(rows: PendingPrompt[]): PendingPrompt[] {
  return rows
    .filter(
      (r) =>
        r.state === 'queued' ||
        r.state === 'sending' ||
        r.state === 'unresolved',
    )
    .sort((a, b) => a.seq - b.seq);
}

/** The text a teammate's message reaches the agent with — who is speaking. */
export function deliveredText(
  row: PendingPrompt,
  run: Pick<AgentRun, 'ownerMemberId'>,
  memberName: (memberId: string) => string | null,
): string {
  if (row.byMemberId === run.ownerMemberId) return row.text;
  const name = memberName(row.byMemberId) ?? 'a teammate';
  return `From ${name} in Waypoint:\n\n${row.text}`;
}

/** Accept a message into the outbox: the row, plus its `prompt_queued` event (written by the backend). */
export async function enqueue(
  deps: OutboxDeps,
  runId: string,
  text: string,
  reason: PendingPromptReason,
): Promise<PendingPrompt> {
  const row = await deps.ledger.createPendingPrompt(runId, { text, reason });
  deps.logger.info('engine: message outboxed', {
    runId,
    pendingId: row.id,
    reason,
  });
  return row;
}

/**
 * A `sending` row left behind by a host that died between the daemon
 * call and the `delivered` write. Resolved by looking at what the daemon
 * has: the text among its recent user messages → it was delivered; the
 * session gone → it cannot have been → back to `queued`; the session
 * live but actively generating a turn → the daemon call plausibly went
 * through and IS that turn, just not committed to history yet — wait
 * rather than guess (found in review: `daemon.sendPrompt` races its RPC
 * against a short acceptance window and can resolve well before the
 * agent's turn actually ends, so "not yet in history" is the ordinary
 * case for anything still being worked on, not a rare crash window; a
 * host that crashed mid-turn would otherwise misclassify a genuinely
 * delivered message as `unresolved` on every restart, and a later Resend
 * would then hand the same text to the agent a second time). Only when
 * the session is live, idle, and the text is nowhere in recent history
 * is the honest answer `unresolved` — and only a person moves it on
 * from there.
 */
async function resolveStale(
  deps: OutboxDeps,
  daemon: DaemonRunsApi,
  run: AgentRun,
  row: PendingPrompt,
): Promise<'delivered' | 'queued' | 'unresolved' | 'deferred'> {
  const wanted = row.text.trim();
  const sessions: Record<string, { isGenerating?: boolean }> = await daemon
    .listSessions()
    .catch(() => ({}));
  const live = sessions[run.id];
  if (!live) {
    await deps.ledger.updatePendingPrompt(run.id, row.id, { state: 'queued' });
    return 'queued';
  }
  const history = await daemon
    .getHistory(run.id, RESOLVE_HISTORY_TURNS)
    .catch(() => []);
  const seen = history.some((turn) =>
    turn.items.some(
      (item) =>
        item.kind === 'message' &&
        item.role === 'user' &&
        typeof item.text === 'string' &&
        item.text.trim() === wanted,
    ),
  );
  if (seen) {
    await deps.ledger.updatePendingPrompt(run.id, row.id, {
      state: 'delivered',
    });
    return 'delivered';
  }
  if (live.isGenerating) {
    // Left claimed `sending`, not in history yet, the agent is
    // working: this drain leaves the row exactly as it found it — no
    // ledger write — so the next drain (the turn's own end, a later
    // mount/focus, a person's Resend) re-checks with the turn's actual
    // outcome on record instead of a guess made mid-flight.
    return 'deferred';
  }
  await deps.ledger.updatePendingPrompt(run.id, row.id, {
    state: 'unresolved',
  });
  return 'unresolved';
}

export interface DrainResult {
  delivered: number;
  /** A row that could not be sent and now blocks the rest, with why. */
  blockedBy: {
    row: PendingPrompt;
    why: 'unresolved' | 'spawn-failed' | 'no-session' | 'still-generating';
  } | null;
}

/**
 * Deliver the run's open rows, in order, to a LIVE session. The caller
 * has established the session (a plain live run, or one it just resumed
 * or warmed) and holds the run lock. Stops at the first row it cannot
 * deliver and says why; never throws for a row's own failure.
 */
export async function drain(
  deps: OutboxDeps,
  daemon: DaemonRunsApi,
  run: AgentRun,
  options: {
    trigger: DrainTrigger;
    /** hiddenContext for the first prompt delivered (a resume note, the continuation note). */
    hiddenContext?: string;
    memberName?: (memberId: string) => string | null;
    /**
     * Only these rows (by id): a send delivers the rows that were already
     * waiting when it began BEFORE its own text, and the rows that
     * arrived while it was resuming AFTER — arrival order, end to end.
     */
    only?: ReadonlySet<string>;
  },
): Promise<DrainResult> {
  const rows = openRows(await deps.ledger.listPendingPrompts(run.id)).filter(
    (r) => !options.only || options.only.has(r.id),
  );
  let delivered = 0;
  let context: string | undefined = options.hiddenContext;
  const memberName = options.memberName ?? (() => null);
  // eslint-disable-next-line no-restricted-syntax -- sequential on purpose: FIFO
  for (const row of rows) {
    // A claim left by a dead host comes first — nothing newer is sent
    // past a message whose fate is unknown.
    if (row.state === 'sending') {
      // eslint-disable-next-line no-await-in-loop
      const fate = await resolveStale(deps, daemon, run, row);
      if (fate === 'delivered') {
        delivered += 1;
        // eslint-disable-next-line no-continue
        continue;
      }
      if (fate === 'unresolved')
        return { delivered, blockedBy: { row, why: 'unresolved' } };
      if (fate === 'deferred')
        return { delivered, blockedBy: { row, why: 'still-generating' } };
      // queued again: falls through to a fresh attempt below
    } else if (row.state === 'unresolved') {
      return { delivered, blockedBy: { row, why: 'unresolved' } };
    }
    const automatic = options.trigger !== 'send' && options.trigger !== 'retry';
    if (automatic && row.autoAttempts >= MAX_AUTO_ATTEMPTS) {
      return { delivered, blockedBy: { row, why: 'spawn-failed' } };
    }
    // eslint-disable-next-line no-await-in-loop
    await deps.ledger.updatePendingPrompt(run.id, row.id, { state: 'sending' });
    try {
      // eslint-disable-next-line no-await-in-loop
      await daemon.sendPrompt(
        run.id,
        deliveredText(row, run, memberName),
        context,
      );
      context = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A refusal inside the acceptance window: nothing was queued — safe
      // to try again later, counted against the automatic bound.
      // eslint-disable-next-line no-await-in-loop
      await deps.ledger.updatePendingPrompt(run.id, row.id, {
        state: 'queued',
        autoAttempts: automatic ? row.autoAttempts + 1 : 0,
        lastError: message,
      });
      deps.logger.warn('engine: outbox delivery refused', {
        runId: run.id,
        pendingId: row.id,
        message,
      });
      return { delivered, blockedBy: { row, why: 'spawn-failed' } };
    }
    // eslint-disable-next-line no-await-in-loop
    await deps.ledger.updatePendingPrompt(run.id, row.id, {
      state: 'delivered',
    });
    delivered += 1;
  }
  return { delivered, blockedBy: null };
}

/**
 * The open rows as a start's `initialQueue` (continueStart, design §2.4
 * trigger 1): claimed `sending` first, so a host that dies between here
 * and the daemon's answer leaves the same evidence a plain drain would.
 * The caller marks them `delivered` once `startSession` has answered.
 */
export async function claimForInitialQueue(
  deps: OutboxDeps,
  run: AgentRun,
  memberName: (memberId: string) => string | null = () => null,
): Promise<Array<{ row: PendingPrompt; text: string }>> {
  const rows = openRows(await deps.ledger.listPendingPrompts(run.id)).filter(
    (r) => r.state === 'queued',
  );
  const claimed: Array<{ row: PendingPrompt; text: string }> = [];
  try {
    // eslint-disable-next-line no-restricted-syntax -- sequential on purpose: FIFO
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await deps.ledger.updatePendingPrompt(run.id, row.id, {
        state: 'sending',
      });
      claimed.push({ row, text: deliveredText(row, run, memberName) });
    }
  } catch (error) {
    // Found in review: a mid-loop failure (the Nth claim's own request
    // fails) used to leave the first N-1 rows wedged `sending` with no
    // revert — the same "claim doesn't reflect reality" bug class
    // `revertClaimed` above exists for, just triggered by this loop's own
    // I/O failing instead of the caller never getting to use the claim.
    // Still rethrown: the caller (continueStart) needs to know this
    // failed, same as before this fix.
    await revertClaimed(
      deps,
      run.id,
      claimed.map((c) => c.row),
    );
    throw error;
  }
  return claimed;
}

export async function markDelivered(
  deps: OutboxDeps,
  runId: string,
  rows: PendingPrompt[],
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- sequential on purpose: FIFO
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await deps.ledger
      .updatePendingPrompt(runId, row.id, { state: 'delivered' })
      .catch(() => {});
  }
}

/**
 * The mirror of `markDelivered`, for a claim that turned out to have
 * nowhere to land — a start's `initialQueue` whose session was killed
 * before the caller could tell whether the agent ever saw it (found in
 * review: `continueStart` used to mark these `delivered` regardless).
 * Back to `queued`, as undelivered as the day they were claimed; the
 * backend clears `claimedAt` itself on this transition.
 */
export async function revertClaimed(
  deps: OutboxDeps,
  runId: string,
  rows: PendingPrompt[],
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- sequential on purpose: FIFO
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await deps.ledger
      .updatePendingPrompt(runId, row.id, { state: 'queued' })
      .catch(() => {});
  }
}

/** Every automatic-attempt counter on the run back to zero — a person acted. */
export async function resetAutoAttempts(
  deps: OutboxDeps,
  runId: string,
): Promise<void> {
  const rows = openRows(await deps.ledger.listPendingPrompts(runId));
  // eslint-disable-next-line no-restricted-syntax -- sequential on purpose: FIFO
  for (const row of rows) {
    if (row.autoAttempts > 0) {
      // eslint-disable-next-line no-await-in-loop
      await deps.ledger
        .updatePendingPrompt(runId, row.id, { autoAttempts: 0 })
        .catch(() => {});
    }
  }
}
