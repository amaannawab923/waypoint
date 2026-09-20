import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentRunEvents, agentRunPendingPrompts, agentRuns, members } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';
import type { CreatePendingPromptInput, UpdatePendingPromptInput } from '../validation/agentRuns.schema.js';

// Never-lock (2026-09-20): the per-run outbox. A message the host could
// not hand to the daemon right now is accepted here, not refused — the
// session is starting, finalize holds the row, the worktree's folder or
// repository cannot be reached, the spawn failed, or the sender is a
// teammate whose Waypoint does not run this session. The owner's host
// drains it, at most once, when it can. What this file promises:
//
//  - `seq` is minted under the run's row lock: FIFO, never two the same.
//  - A row's state moves queued → sending → delivered | unresolved, or
//    → dropped; `queued` is the only state a drain may take it from, and
//    `sending` is a claim the host makes BEFORE the daemon call, so a host
//    that dies mid-call leaves a row that says so.
//  - Every transition is also an `agent_run_events` row in the same
//    transaction (prompt_queued / prompt_sent / prompt_dropped), carrying
//    ids only — the transcript's markers read the events; the text lives
//    here.
//  - Workspace-scoped like appendEvent. Any member may enqueue (that is
//    the point — a teammate's message reaches the owner); only the owner
//    moves a row through sending/delivered/unresolved; the author or the
//    owner may drop it.

export type PendingPrompt = typeof agentRunPendingPrompts.$inferSelect;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function ownerWorkspaceId(tx: Tx, ownerMemberId: string): Promise<string | null> {
  const [row] = await tx.select({ workspaceId: members.workspaceId }).from(members).where(eq(members.id, ownerMemberId));
  return row?.workspaceId ?? null;
}

async function lockRunInWorkspace(tx: Tx, runId: string) {
  const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).for('update');
  if (!run || (await ownerWorkspaceId(tx, run.ownerMemberId)) !== currentWorkspaceId()) {
    throw new NotFoundError('agent run');
  }
  return run;
}

async function writeEvent(tx: Tx, runId: string, kind: string, payload: Record<string, unknown>) {
  const [{ max }] = await tx
    .select({ max: sql<number>`coalesce(max(${agentRunEvents.seq}), 0)` })
    .from(agentRunEvents)
    .where(eq(agentRunEvents.runId, runId));
  await tx.insert(agentRunEvents).values({ runId, seq: Number(max) + 1, kind, payload });
}

export async function listPendingPrompts(runId: string): Promise<PendingPrompt[]> {
  return db.transaction(async (tx) => {
    await lockRunInWorkspace(tx, runId);
    return tx
      .select()
      .from(agentRunPendingPrompts)
      .where(eq(agentRunPendingPrompts.runId, runId))
      .orderBy(asc(agentRunPendingPrompts.seq));
  });
}

export async function createPendingPrompt(runId: string, input: CreatePendingPromptInput): Promise<PendingPrompt> {
  return db.transaction(async (tx) => {
    const run = await lockRunInWorkspace(tx, runId);
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${agentRunPendingPrompts.seq}), 0)` })
      .from(agentRunPendingPrompts)
      .where(eq(agentRunPendingPrompts.runId, runId));
    const by = currentMemberId();
    // Never trust a caller's own claim for WHY a message is waiting — a
    // teammate creating a row on someone else's run can only ever be
    // waiting because that owner's Waypoint isn't the one draining it
    // (`owner-offline`), whatever `input.reason` says; only the owner's
    // own host, enqueuing its own outbox row, gets to name the real
    // obstacle (found in review: the reason was accepted from the client
    // unconstrained by who was actually calling).
    const reason = by === run.ownerMemberId ? input.reason : 'owner-offline';
    const [row] = await tx
      .insert(agentRunPendingPrompts)
      .values({
        id: newId('pp'),
        runId,
        seq: Number(max) + 1,
        byMemberId: by,
        text: input.text,
        reason,
      })
      .returning();
    await writeEvent(tx, runId, 'prompt_queued', {
      queuedId: row.id,
      reason: row.reason,
      by,
      ...(by !== run.ownerMemberId ? { forOwner: run.ownerMemberId } : {}),
    });
    return row;
  });
}

const ALLOWED: Record<string, readonly string[]> = {
  queued: ['sending', 'dropped'],
  sending: ['delivered', 'unresolved', 'queued', 'dropped'],
  unresolved: ['queued', 'delivered', 'dropped'],
  delivered: [],
  dropped: [],
};

export async function updatePendingPrompt(
  runId: string,
  pendingId: string,
  input: UpdatePendingPromptInput,
): Promise<PendingPrompt> {
  return db.transaction(async (tx) => {
    const run = await lockRunInWorkspace(tx, runId);
    const [current] = await tx
      .select()
      .from(agentRunPendingPrompts)
      .where(and(eq(agentRunPendingPrompts.id, pendingId), eq(agentRunPendingPrompts.runId, runId)))
      .for('update');
    if (!current) throw new NotFoundError('pending prompt');

    const me = currentMemberId();
    const isOwner = me === run.ownerMemberId;
    const patch: Partial<typeof agentRunPendingPrompts.$inferInsert> = {};
    if (input.state !== undefined && input.state !== current.state) {
      if (!ALLOWED[current.state]?.includes(input.state)) {
        throw new ConflictError(`A ${current.state} pending prompt cannot become ${input.state}.`);
      }
      if (input.state === 'dropped') {
        if (!isOwner && me !== current.byMemberId) {
          throw new ConflictError('Only the run owner or the message author can drop a pending prompt.');
        }
      } else if (!isOwner) {
        throw new ConflictError('Only the run owner delivers pending prompts.');
      }
      patch.state = input.state;
      if (input.state === 'sending') patch.claimedAt = new Date();
      if (input.state === 'delivered' || input.state === 'unresolved' || input.state === 'dropped') {
        patch.resolvedAt = new Date();
      }
      if (input.state === 'queued') patch.claimedAt = null;
    }
    // `reason`/`autoAttempts`/`lastError` are the drain's own bookkeeping
    // (outbox.ts sets these on the owner's host alone, sometimes with no
    // `state` change at all — e.g. `resetAutoAttempts`) — never a field a
    // request without a `state` transition should be able to touch. Gated
    // here too, not just above: a request with `state` equal to the row's
    // current state (or omitted) used to skip the owner check entirely and
    // still fall through to these three unconditional writes, letting any
    // workspace member rewrite another member's row (found in review).
    if (input.reason !== undefined || input.autoAttempts !== undefined || input.lastError !== undefined) {
      if (!isOwner) {
        throw new ConflictError('Only the run owner updates a pending prompt’s delivery bookkeeping.');
      }
      if (input.reason !== undefined) patch.reason = input.reason;
      if (input.autoAttempts !== undefined) patch.autoAttempts = input.autoAttempts;
      if (input.lastError !== undefined) patch.lastError = input.lastError;
    }
    if (Object.keys(patch).length === 0) return current;

    const [updated] = await tx
      .update(agentRunPendingPrompts)
      .set(patch)
      .where(eq(agentRunPendingPrompts.id, pendingId))
      .returning();

    if (patch.state === 'sending') {
      await writeEvent(tx, runId, 'prompt_sent', { queuedId: pendingId, phase: 'claimed', by: current.byMemberId });
    } else if (patch.state === 'delivered') {
      await writeEvent(tx, runId, 'prompt_sent', { queuedId: pendingId, phase: 'delivered', by: current.byMemberId });
    } else if (patch.state === 'dropped') {
      await writeEvent(tx, runId, 'prompt_dropped', { queuedId: pendingId, by: me });
    }
    return updated;
  });
}
