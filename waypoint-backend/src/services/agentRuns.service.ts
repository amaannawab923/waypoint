import { and, asc, desc, eq, getTableColumns, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentRuns, agentRunEvents, agentRunTranscripts, agents, members, projects, ticketRefs, tickets } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/errors.js';
import { isExternalRef } from '../lib/externalRefs.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';
import { assertConversationOwnedByMember } from './copilot.service.js';
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
  SaveAgentRunTranscriptInput,
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

// AT11 (ROAD-146) fifth review round: this whole file had no workspace
// scoping anywhere — deferred through three review rounds as lower
// severity than the rest of the audit, until round 4 found two of its
// fields (ownerMemberId, copilotConversationId) were actually load-bearing
// for proposals.service.ts's own workspace check, and round 5 proved a
// live cross-tenant read+destructive-write through the one path that
// fix didn't cover (updateRun comparing a conversation's ownership
// against the CALLER instead of the RUN's real owner). That pattern —
// three rounds, three different load-bearing fields in the same
// "deferred" file — is what settled it: this file needed the guard the
// rest of the audit already gives everything else, not another
// one-field patch.
//
// ownerMemberId is not a workspaceId column, but every run's owner is a
// real member (forced to currentMemberId() at creation since round 4),
// and every member belongs to exactly one workspace — so joining through
// ownerMemberId is exactly workspaceProjectIdsSubquery()'s own pattern,
// one join away instead of a subquery.
async function ownerWorkspaceId(executor: Tx | typeof db, ownerMemberId: string): Promise<string | null> {
  const [row] = await executor.select({ workspaceId: members.workspaceId }).from(members).where(eq(members.id, ownerMemberId));
  return row?.workspaceId ?? null;
}

/**
 * Throws NotFoundError('agent run') unless `runId` belongs to a member of
 * the current request's workspace. For the ROUTE layer only — every
 * bare-id route in agentRuns.routes.ts calls this before touching the
 * run. Deliberately NOT called from inside updateRun/appendEvent
 * themselves: updateRun is also reached from proposals.service.ts's
 * settleRunIfDecided, including a request-less expiry sweep that
 * legitimately settles runs across every workspace, where
 * currentWorkspaceId() would just be Personal's fallback and would
 * wrongly refuse a real cross-tenant sweep. Functions with no such
 * request-less caller (getRun, listRuns, listRunsForTicket, createRun's
 * own retryOfRunId check, appendEvent) scope themselves directly instead.
 */
export async function assertRunInWorkspace(runId: string): Promise<void> {
  const [run] = await db.select({ ownerMemberId: agentRuns.ownerMemberId }).from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run || (await ownerWorkspaceId(db, run.ownerMemberId)) !== currentWorkspaceId()) {
    throw new NotFoundError('agent run');
  }
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
  // AT11 (ROAD-146) third review round: two fields this function used to
  // write straight from the request body turned out to be load-bearing
  // for proposals.service.ts's own workspace check — createRunProposal
  // copies a run's ownerMemberId/copilotConversationId onto every
  // proposal it files, and proposalWorkspaceCondition trusts those
  // columns to know whose workspace a run-origin proposal belongs to.
  // An attacker naming a real victim's memberId/conversationId here could
  // get their own proposal to render inside the victim's review queue or
  // Copilot panel. ownerMemberId is now always the real caller,
  // regardless of what the request claims; copilotConversationId, if
  // given, must actually belong to that same caller.
  const ownerMemberId = currentMemberId();
  if (input.copilotConversationId) {
    await assertConversationOwnedByMember(input.copilotConversationId, ownerMemberId);
  }
  return db.transaction(async (tx) => {
    // Sixth review round: projectId/ticketId were the last unscoped id
    // fields left in this function — a real cross-tenant existence +
    // relationship oracle (four distinguishable responses told a caller
    // whether a given id existed in ANOTHER workspace, and whether a
    // ticket belonged to a given project there), proven live. Folded into
    // this same ValidationError('...does not exist') wherever the field
    // was already validated for plain existence, so a cross-tenant match
    // reads identically to a genuinely missing one.
    if (input.ticketId && isExternalRef(input.ticketId)) {
      // W5b (ROAD-126): a run on a Jira issue names the issue's ledger
      // handle. The handle must exist — the FK that used to prove a
      // ticket id is gone (schema/agentRuns.ts), so the service proves it
      // — and the project is whatever the folder said, not the issue's:
      // a Jira issue belongs to no Waypoint project. ticket_refs itself
      // carries no workspace concept (noted elsewhere in this epic), so
      // projectId — if also given — is the one thing left to check here.
      const [ref] = await tx
        .select({ id: ticketRefs.id })
        .from(ticketRefs)
        .where(eq(ticketRefs.id, input.ticketId));
      if (!ref) throw new ValidationError('ticketId does not exist');
      if (input.projectId) {
        const [project] = await tx.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, input.projectId));
        if (!project || project.workspaceId !== currentWorkspaceId()) throw new ValidationError('projectId does not exist');
      }
    } else if (input.ticketId) {
      // A run about a ticket is a run in that ticket's project — the
      // drawer lists by ticket, the panel by project, and a row that says
      // otherwise would appear in one and not the other.
      const [ticket] = await tx
        .select({ projectId: tickets.projectId, workspaceId: projects.workspaceId })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(eq(tickets.id, input.ticketId));
      if (!ticket || ticket.workspaceId !== currentWorkspaceId()) throw new ValidationError('ticketId does not exist');
      if (ticket.projectId !== input.projectId) {
        throw new ValidationError('ticketId belongs to a different project than projectId');
      }
    } else if (input.projectId) {
      const [project] = await tx.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, input.projectId));
      if (!project || project.workspaceId !== currentWorkspaceId()) throw new ValidationError('projectId does not exist');
    }
    // Eighth review round, proven live: the one id field in this
    // function's own insert this round's earlier passes never reached —
    // an existence + workspace oracle, real 201 vs fake 400, identical
    // to the projectId/ticketId gap the sixth round already fixed here.
    if (input.agentId) {
      const [agent] = await tx.select({ workspaceId: agents.workspaceId }).from(agents).where(eq(agents.id, input.agentId));
      if (!agent || agent.workspaceId !== currentWorkspaceId()) throw new ValidationError('agentId does not exist');
    }
    if (input.retryOfRunId) {
      // The retried run must exist and be over: retrying a run that is
      // still going would race it for the same ticket's worktree. Read
      // under the row lock (found in review): a plain select could see
      // `interrupted` while a Resume was mid-commit, and both would land.
      let prior: AgentRun;
      try {
        prior = await lockRun(tx, input.retryOfRunId);
        // Fifth review round, proven live: without this, naming another
        // workspace's real run here cancelled it outright (a forged
        // 'superseded by a retry' event in a stranger's ledger) — and,
        // against a still-running one, the ConflictError below leaked
        // its existence and status to an unrelated tenant. Folded into
        // this same try so a cross-tenant match reads exactly like a
        // missing id, not a distinguishable refusal.
        if ((await ownerWorkspaceId(tx, prior.ownerMemberId)) !== currentWorkspaceId()) {
          throw new NotFoundError('agent run');
        }
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
        ownerMemberId,
        agentId: input.agentId ?? null,
        entry: input.entry,
        providerId: input.providerId,
        title: input.title ?? null,
        isolation: input.isolation ?? 'worktree',
        autoApprove: input.autoApprove ?? false,
        intent: input.intent ?? null,
        modeId: input.modeId ?? null,
        copilotConversationId: input.copilotConversationId ?? null,
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

// Fifth review round: scoped directly, safe unconditionally — unlike
// updateRun, neither of getRun's two callers (the GET /agent-runs/:id
// route, proposals.service.ts's createRunProposal) is ever request-less.
export async function getRun(id: string): Promise<AgentRun | null> {
  const [row] = await db
    .select(getTableColumns(agentRuns))
    .from(agentRuns)
    .innerJoin(members, eq(members.id, agentRuns.ownerMemberId))
    .where(and(eq(agentRuns.id, id), eq(members.workspaceId, currentWorkspaceId())));
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
  // Fifth review round: this had no workspace filter at all — every
  // tenant's whole run list, unpaged past the cursor, to any caller.
  conditions.push(eq(members.workspaceId, currentWorkspaceId()));
  const rows = await db
    .select({ run: agentRuns, createdAtText: sql<string>`${agentRuns.createdAt}::text` })
    .from(agentRuns)
    .innerJoin(members, eq(members.id, agentRuns.ownerMemberId))
    .where(and(...conditions))
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
  // Fifth review round: unscoped — ticketId names a native ticket in any
  // workspace, or a Jira ledger handle with no workspace concept of its
  // own (ticket_refs, same gap noted elsewhere in this epic), so filtering
  // by the run's real owner is the one basis available either way.
  return db
    .select(getTableColumns(agentRuns))
    .from(agentRuns)
    .innerJoin(members, eq(members.id, agentRuns.ownerMemberId))
    .where(and(eq(agentRuns.ticketId, ticketId), eq(members.workspaceId, currentWorkspaceId())))
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
    const run = await lockRun(tx, runId);
    // Fifth review round: safe to scope directly here (unlike updateRun,
    // this function's only caller is its own route — never
    // settleRunIfDecided's request-less sweep).
    if ((await ownerWorkspaceId(tx, run.ownerMemberId)) !== currentWorkspaceId()) {
      throw new NotFoundError('agent run');
    }
    return writeEvent(tx, runId, input.kind, input.payload ?? {});
  });
}

// W5a follow-up (ROAD-124): the transcript snapshot, replaced whole.
export interface AgentRunTranscript {
  runId: string;
  turns: unknown[];
  turnCount: number;
  capturedAt: Date;
}

export async function saveTranscript(
  runId: string,
  input: SaveAgentRunTranscriptInput,
): Promise<AgentRunTranscript> {
  const run = await getRun(runId);
  if (!run) throw new NotFoundError('agent run');
  const [row] = await db
    .insert(agentRunTranscripts)
    .values({ runId, turns: input.turns, turnCount: input.turns.length, capturedAt: new Date() })
    .onConflictDoUpdate({
      target: agentRunTranscripts.runId,
      set: { turns: input.turns, turnCount: input.turns.length, capturedAt: new Date() },
    })
    .returning();
  return { ...row, turns: row.turns as unknown[] };
}

export async function getTranscript(runId: string): Promise<AgentRunTranscript | null> {
  // Fifth review round: previously had no ownership check on the run at
  // all — a full session transcript of another tenant's agent run, by
  // id, to anyone. Safe to scope directly: this function's only caller
  // is its own route.
  const [row] = await db
    .select(getTableColumns(agentRunTranscripts))
    .from(agentRunTranscripts)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunTranscripts.runId))
    .innerJoin(members, eq(members.id, agentRuns.ownerMemberId))
    .where(and(eq(agentRunTranscripts.runId, runId), eq(members.workspaceId, currentWorkspaceId())))
    .limit(1);
  return row ? { ...row, turns: row.turns as unknown[] } : null;
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
    // AT11 (ROAD-146) third review round: same reasoning as createRun's
    // own copilotConversationId check above — this field is load-bearing
    // for proposals.service.ts's workspace check, so a PATCH cannot be
    // allowed to repoint an existing run at a conversation its own owner
    // doesn't hold.
    //
    // Fifth review round, proven live: this compared the conversation
    // against currentMemberId() — the CALLER — not current.ownerMemberId
    // — the RUN's real owner. Those are only the same person when you're
    // patching your own run, which nothing here checks; PATCHing a
    // stranger's run to point at your OWN conversation passed this
    // check every time. createRunProposal then copies that conversation
    // id onto the run's next proposal, and proposalWorkspaceCondition's
    // conversation branch renders it in YOUR queue — with the victim's
    // ticket title/identifier and report body — even though the run,
    // and its ownerMemberId, both still belong to them. Comparing
    // against the run's own owner instead closes this regardless of who
    // is doing the patching, request-context or not — this is a data-
    // to-data check, not a caller-to-data one, so it stays correct for
    // settleRunIfDecided's request-less callers below too.
    if (fields.copilotConversationId) {
      await assertConversationOwnedByMember(fields.copilotConversationId, current.ownerMemberId);
    }
    // A finished run is evidence. Found in review: the header promised
    // "nothing here updates a finished run's worktree or outcome" while a
    // field-only patch on a cancelled run went straight through. The one
    // thing still accepted is a status-only patch to the status it has —
    // an idempotent retry, handled below.
    // W6: the one field that is not the run's outcome — its pull request,
    // which the host may open (or retry) after the run is done (Open PR in
    // the header) — may be written on a finished run, and only once.
    const onlyPrUrl =
      status === undefined &&
      Object.keys(fields).length === 1 &&
      typeof fields.prUrl === 'string' &&
      current.prUrl === null;
    if (
      isTerminal(current.status) &&
      !(Object.keys(fields).length === 0 && status === current.status) &&
      !onlyPrUrl
    ) {
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
