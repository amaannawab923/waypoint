import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentRuns, agentRunEvents } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/errors.js';
import {
  canTransition,
  describeRefusedTransition,
  isTerminal,
  type AgentRunStatus,
} from './runStatusMachine.js';
import type {
  AppendAgentRunEventInput,
  CreateAgentRunInput,
  ListAgentRunsQuery,
  UpdateAgentRunInput,
} from '../validation/agentRuns.schema.js';

// The agent-runs ledger — ROAD-54 (routes), ROAD-56 (relations). What this
// file promises:
//
//  - A run's status only ever moves along runStatusMachine.ts's arrows.
//    Anything else is a ConflictError (409) and changes nothing.
//  - Every status change is also an `agent_run_events` row, written in the
//    same transaction. The trail cannot say something the row does not.
//  - Event `seq` is minted under the run's row lock. Two appenders racing
//    get consecutive numbers, never the same one, and the primary key on
//    (run_id, seq) is the backstop if the lock is ever bypassed.
//  - A run is a row. A retry is a new row that names the one it retries;
//    nothing here updates a finished run's worktree or outcome.

export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentRunEvent = typeof agentRunEvents.$inferSelect;

/** Everything the service itself writes, plus the client vocabulary. */
export type AgentRunEventKind =
  | 'created'
  | 'status_changed'
  | AppendAgentRunEventInput['kind'];

const DEFAULT_PAGE = 50;
// A run's summary is the agent's final message, shown on a card — never
// the transcript. Longer is truncated with a marker rather than refused,
// because the message the model wrote is still the most useful thing to
// keep when it ran long.
const MAX_SUMMARY_CHARS = 20_000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface RunPage {
  items: AgentRun[];
  nextCursor: string | null;
}

interface Cursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { c: string; i: string };
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime()) || typeof parsed.i !== 'string' || !parsed.i) {
      throw new Error('malformed');
    }
    return { createdAt, id: parsed.i };
  } catch {
    throw new ValidationError('invalid cursor');
  }
}

/**
 * Locks the run row for the rest of the transaction and returns it. Every
 * writer goes through here, which is what makes `seq` minting and status
 * checks race-free: the second writer waits on the first's commit and then
 * sees its result.
 */
async function lockRun(tx: Tx, runId: string): Promise<AgentRun> {
  const [row] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).for('update');
  if (!row) throw new NotFoundError('agent run');
  return row;
}

async function nextSeq(tx: Tx, runId: string): Promise<number> {
  const [{ max }] = await tx
    .select({ max: sql<number>`coalesce(max(${agentRunEvents.seq}), 0)` })
    .from(agentRunEvents)
    .where(eq(agentRunEvents.runId, runId));
  return Number(max) + 1;
}

async function writeEvent(
  tx: Tx,
  runId: string,
  kind: AgentRunEventKind,
  payload: Record<string, unknown>,
): Promise<AgentRunEvent> {
  const seq = await nextSeq(tx, runId);
  const [event] = await tx.insert(agentRunEvents).values({ runId, seq, kind, payload }).returning();
  return event;
}

export async function createRun(input: CreateAgentRunInput): Promise<AgentRun> {
  return db.transaction(async (tx) => {
    if (input.retryOfRunId) {
      // The retried run must exist and be over: retrying a run that is
      // still going would race it for the same ticket's worktree.
      const [prior] = await tx.select().from(agentRuns).where(eq(agentRuns.id, input.retryOfRunId));
      if (!prior) throw new NotFoundError('retried agent run');
      if (!isTerminal(prior.status) && prior.status !== 'interrupted') {
        throw new ConflictError(`Run ${prior.id} is ${prior.status}; only a finished or interrupted run can be retried.`);
      }
    }
    const [run] = await tx
      .insert(agentRuns)
      .values({
        id: newId('run'),
        projectId: input.projectId,
        ticketId: input.ticketId ?? null,
        ownerMemberId: input.ownerMemberId,
        agentId: input.agentId ?? null,
        entry: input.entry,
        providerId: input.providerId,
        baseRef: input.baseRef ?? null,
        retryOfRunId: input.retryOfRunId ?? null,
      })
      .returning();
    await writeEvent(tx, run.id, 'created', {
      entry: run.entry,
      providerId: run.providerId,
      ticketId: run.ticketId,
      ownerMemberId: run.ownerMemberId,
      retryOfRunId: run.retryOfRunId,
    });
    return run;
  });
}

export async function getRun(id: string): Promise<AgentRun | null> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
  return row ?? null;
}

/** Newest first, keyset-paginated on (created_at, id) like the review queue. */
export async function listRuns(query: ListAgentRunsQuery): Promise<RunPage> {
  const limit = query.limit ?? DEFAULT_PAGE;
  const conditions = [];
  if (query.projectId) conditions.push(eq(agentRuns.projectId, query.projectId));
  if (query.ownerMemberId) conditions.push(eq(agentRuns.ownerMemberId, query.ownerMemberId));
  if (query.ticketId) conditions.push(eq(agentRuns.ticketId, query.ticketId));
  if (query.status) conditions.push(inArray(agentRuns.status, query.status));
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    conditions.push(
      or(lt(agentRuns.createdAt, c.createdAt), and(eq(agentRuns.createdAt, c.createdAt), lt(agentRuns.id, c.id)))!,
    );
  }
  const rows = await db
    .select()
    .from(agentRuns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null };
}

/** The ticket drawer's list (ROAD-56): every run ever made about this ticket, newest first. */
export async function listRunsForTicket(ticketId: string): Promise<AgentRun[]> {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.ticketId, ticketId))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id));
}

export async function listEvents(
  runId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<AgentRunEvent[]> {
  const run = await getRun(runId);
  if (!run) throw new NotFoundError('agent run');
  const conditions = [eq(agentRunEvents.runId, runId)];
  if (options.afterSeq !== undefined) conditions.push(gt(agentRunEvents.seq, options.afterSeq));
  return db
    .select()
    .from(agentRunEvents)
    .where(and(...conditions))
    .orderBy(asc(agentRunEvents.seq))
    .limit(options.limit ?? 200);
}

export async function appendEvent(runId: string, input: AppendAgentRunEventInput): Promise<AgentRunEvent> {
  return db.transaction(async (tx) => {
    await lockRun(tx, runId);
    return writeEvent(tx, runId, input.kind, input.payload ?? {});
  });
}

function truncateSummary(summary: string | null | undefined): string | null | undefined {
  if (typeof summary !== 'string' || summary.length <= MAX_SUMMARY_CHARS) return summary;
  return `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/**
 * Field patch + optional status move, one transaction, one row lock. A
 * refused move throws ConflictError and nothing — not even the field
 * patch — is written: a caller that sent both meant them together.
 */
export async function updateRun(runId: string, input: UpdateAgentRunInput): Promise<AgentRun> {
  return db.transaction(async (tx) => {
    const current = await lockRun(tx, runId);
    const { status, reason, ...fields } = input;
    const patch: Partial<typeof agentRuns.$inferInsert> = {
      ...fields,
      summary: truncateSummary(fields.summary),
      // numeric columns come back as strings from postgres-js; write them
      // the same way so the driver never guesses a float.
      costUsd: fields.costUsd === undefined ? undefined : fields.costUsd === null ? null : String(fields.costUsd),
      updatedAt: new Date(),
    };
    // A key that was not sent must not become `undefined` in `.set()` —
    // drizzle skips undefined, but be explicit for the two we rewrote.
    if (fields.summary === undefined) delete patch.summary;
    if (fields.costUsd === undefined) delete patch.costUsd;

    let moved: { from: AgentRunStatus; to: AgentRunStatus } | null = null;
    if (status !== undefined && status !== current.status) {
      if (!canTransition(current.status, status)) {
        throw new ConflictError(describeRefusedTransition(current.status, status));
      }
      moved = { from: current.status, to: status };
      patch.status = status;
      const now = new Date();
      if (status === 'running' && current.startedAt === null) patch.startedAt = now;
      if (isTerminal(status)) patch.endedAt = now;
      // Leaving `blocked` clears what it was blocked on, unless the caller
      // set a new one in the same patch (a blocked → blocked re-ask is not
      // a transition, so that case never reaches here).
      if (current.status === 'blocked' && fields.blockedReason === undefined) patch.blockedReason = null;
    } else if (status !== undefined && status === current.status && Object.keys(fields).length === 0) {
      // A status-only patch to the status it already has: nothing to do,
      // and a 409 for it would make every idempotent retry a failure.
      return current;
    }

    const [updated] = await tx.update(agentRuns).set(patch).where(eq(agentRuns.id, runId)).returning();
    if (moved) {
      await writeEvent(tx, runId, 'status_changed', {
        from: moved.from,
        to: moved.to,
        ...(reason !== undefined ? { reason } : {}),
        ...(fields.blockedReason ? { blockedReason: fields.blockedReason } : {}),
        ...(fields.errorKind ? { errorKind: fields.errorKind } : {}),
        ...(fields.errorMessage ? { errorMessage: fields.errorMessage } : {}),
      });
    }
    return updated;
  });
}
