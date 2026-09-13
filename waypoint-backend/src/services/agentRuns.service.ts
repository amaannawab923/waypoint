import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentRuns, agentRunEvents, tickets } from '../db/schema/index.js';
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
  | 'blocked_reason_changed'
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
  /** `created_at::text` exactly as Postgres renders it — microsecond precision. */
  createdAt: string;
  id: string;
}

// Found in review: a JS Date holds milliseconds, `created_at` holds
// microseconds, so a cursor built from `toISOString()` sat *below* the
// boundary row and the next page skipped every row sharing that
// millisecond (three runs created by concurrent POSTs, page size 1: the
// middle one never came back). The cursor therefore carries the column's
// own text rendering, selected alongside the row, and compares it as a
// timestamptz — exact by construction. (proposals.service.ts's review
// queue has the same defect; ROAD-108 tracks it.)
const CURSOR_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function encodeCursor(row: { createdAtText: string; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAtText, i: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { c: string; i: string };
    if (typeof parsed.c !== 'string' || !CURSOR_TEXT.test(parsed.c) || typeof parsed.i !== 'string' || !parsed.i) {
      throw new Error('malformed');
    }
    return { createdAt: parsed.c, id: parsed.i };
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
    if (input.ticketId) {
      // A run about a ticket is a run in that ticket's project — the
      // drawer lists by ticket, the panel by project, and a row that says
      // otherwise would appear in one and not the other.
      const [ticket] = await tx
        .select({ projectId: tickets.projectId })
        .from(tickets)
        .where(eq(tickets.id, input.ticketId));
      if (!ticket) throw new ValidationError('ticketId does not exist');
      if (ticket.projectId !== input.projectId) {
        throw new ValidationError('ticketId belongs to a different project than projectId');
      }
    }
    if (input.retryOfRunId) {
      // The retried run must exist and be over: retrying a run that is
      // still going would race it for the same ticket's worktree. Read
      // under the row lock (found in review): a plain select could see
      // `interrupted` while a Resume was mid-commit, and both would land.
      let prior: AgentRun;
      try {
        prior = await lockRun(tx, input.retryOfRunId);
      } catch (error) {
        // A body field that names nothing is a bad request, not a missing
        // resource — the resource this POST addresses is the collection.
        if (error instanceof NotFoundError) throw new ValidationError('retryOfRunId does not exist');
        throw error;
      }
      if (!isTerminal(prior.status) && prior.status !== 'interrupted') {
        throw new ConflictError(`Run ${prior.id} is ${prior.status}; only a finished or interrupted run can be retried.`);
      }
      if (prior.status === 'interrupted') {
        // The retry supersedes it: an interrupted run is resumable, and
        // two live runs on one ticket is what the lock above exists to
        // prevent. Cancelled here, under the same lock, with the reason.
        await tx
          .update(agentRuns)
          .set({ status: 'cancelled', endedAt: new Date(), updatedAt: new Date() })
          .where(eq(agentRuns.id, prior.id));
        await writeEvent(tx, prior.id, 'status_changed', {
          from: 'interrupted',
          to: 'cancelled',
          reason: 'superseded by a retry',
        });
      }
    }
    const [run] = await tx
      .insert(agentRuns)
      .values({
        id: newId('run'),
        projectId: input.projectId ?? null,
        ticketId: input.ticketId ?? null,
        ownerMemberId: input.ownerMemberId,
        agentId: input.agentId ?? null,
        entry: input.entry,
        providerId: input.providerId,
        title: input.title ?? null,
        isolation: input.isolation ?? 'worktree',
        autoApprove: input.autoApprove ?? false,
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
    // Keyset on (created_at, id) DESC, the cursor's timestamp compared as
    // the column's own type so no precision is lost on the way round.
    const at = sql`${c.createdAt}::timestamptz`;
    conditions.push(
      or(lt(agentRuns.createdAt, at), and(eq(agentRuns.createdAt, at), lt(agentRuns.id, c.id)))!,
    );
  }
  const rows = await db
    .select({ run: agentRuns, createdAtText: sql<string>`${agentRuns.createdAt}::text` })
    .from(agentRuns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => r.run),
    nextCursor: hasMore && last ? encodeCursor({ createdAtText: last.createdAtText, id: last.run.id }) : null,
  };
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
    // A finished run is evidence. Found in review: the header promised
    // "nothing here updates a finished run's worktree or outcome" while a
    // field-only patch on a cancelled run went straight through. The one
    // thing still accepted is a status-only patch to the status it has —
    // an idempotent retry, handled below.
    if (isTerminal(current.status) && !(Object.keys(fields).length === 0 && status === current.status)) {
      throw new ConflictError(`A ${current.status} run is finished; its record is read-only.`);
    }
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
    // A blocked run asked a second question: not a transition, but the
    // trail must show the question changed (found in review).
    const reasonChanged =
      !moved &&
      current.status === 'blocked' &&
      fields.blockedReason !== undefined &&
      fields.blockedReason !== current.blockedReason;

    const [updated] = await tx.update(agentRuns).set(patch).where(eq(agentRuns.id, runId)).returning();
    if (reasonChanged) {
      await writeEvent(tx, runId, 'blocked_reason_changed', {
        from: current.blockedReason,
        to: fields.blockedReason,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
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
