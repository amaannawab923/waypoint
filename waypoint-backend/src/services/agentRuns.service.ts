import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
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
  isRevivable,
  isTerminal,
  LIVE_RUN_STATUSES,
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
  | 'run_reopened'
  | 'publish_claimed'
  | AppendAgentRunEventInput['kind'];

const DEFAULT_PAGE = 50;
// A run's summary is the agent's final message, shown on a card — never
// the transcript. Longer is truncated with a marker rather than refused,
// because the message the model wrote is still the most useful thing to
// keep when it ran long.
const MAX_SUMMARY_CHARS = 20_000;
// A publish claim (claimPublish) whose holder died mid-push is ignored
// after this long — a claim is otherwise released only by the holder's
// own `finalized` event. The holder never renews it, so this MUST exceed
// the longest a publish can legitimately take: the host bounds every
// command it runs with a hard timeout (pullRequests.ts — a PR lookup,
// a few git reads, the push, the PR create), and the sum of those is the
// most a live claimant can be "still working" for. Found in review
// (round 4): at 3 minutes this was already below that sum, so a slow but
// healthy push could be preempted by a second claimant — exactly the two-
// competing-PRs race the claim exists to prevent. pullRequests.test.ts
// pins the relationship by reading this constant out of this file.
export const PUBLISH_CLAIM_TTL_MS = 10 * 60_000;

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
    // Taken here, before the retry branch's row lock below, so this
    // function's lock order is advisory → row — the same order
    // claimPublish uses — and the two can never deadlock on a ticket.
    // The check itself runs after the retry branch (which may cancel the
    // very run it would otherwise see as live), just before the insert.
    const dispatchTicketId =
      input.entry === 'dispatched' && input.ticketId && input.modeId !== 'plan' ? input.ticketId : null;
    if (dispatchTicketId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${dispatchTicketId}))`);
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
    // One *automatic dispatch* of a ticket at a time. This used to be a
    // partial unique index over live statuses; that also refused a person
    // continuing an old conversation on the ticket (never-lock, 2026-09-20:
    // many conversations may be live on one ticket — what stays single is
    // this, and the publisher, claimPublish). A transaction-scoped
    // advisory lock on the ticket serializes two dispatches racing each
    // other across connections and processes; the select under it sees
    // any row already committed, including a reopened conversation, which
    // also refuses a fresh dispatch — the person is already on it.
    // `queued` counts: a dispatch is a writer from the moment its row
    // exists, not only once provisioning starts. claimPublish takes the
    // same key, so a dispatch and a publish on one ticket serialize too.
    if (dispatchTicketId) {
      const [live] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.ticketId, dispatchTicketId),
            eq(agentRuns.entry, 'dispatched'),
            inArray(agentRuns.status, ['queued', ...LIVE_RUN_STATUSES]),
            or(isNull(agentRuns.modeId), ne(agentRuns.modeId, 'plan')),
          ),
        )
        .limit(1);
      if (live) {
        throw new ConflictError(
          `A writing session is already live on this ticket (${live.id}); it is not dispatched twice.`,
        );
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

/**
 * The reverse of listRunsForTicket: every distinct Jira key this member has
 * ever dispatched or worked a run against on the given site, newest activity
 * first — ROAD-158's "Worked on" tab.
 *
 * Scoped by `ownerMemberId`, not by workspace like listRunsForTicket above:
 * this is inherently a "my own history" read (a Jira key someone else on the
 * team worked is not what "Worked on" means to the person looking at it),
 * so there is no cross-member case here for a workspace-wide filter to add.
 *
 * `ticket_refs.id = agent_runs.ticket_id` is an inner join, not a lookup
 * keyed off the 'tref-' prefix agent_runs.ticketId's own check constraint
 * documents — a native ticket's 'wi-…' id simply never matches any
 * ticket_refs row, so the join alone excludes native-ticket runs without
 * this function needing to know the prefix convention at all. Every status
 * counts, including a run still in flight: "worked on" is a fact about
 * having touched the ticket, not about how that work turned out.
 */
export async function listWorkedOnJiraTickets(ownerMemberId: string, site: string): Promise<string[]> {
  const lastWorkedAt = sql<Date>`max(${agentRuns.createdAt})`;
  const rows = await db
    .select({ key: ticketRefs.cachedIdentifier, lastWorkedAt })
    .from(agentRuns)
    .innerJoin(ticketRefs, eq(ticketRefs.id, agentRuns.ticketId))
    .where(
      and(
        eq(agentRuns.ownerMemberId, ownerMemberId),
        eq(ticketRefs.provider, 'jira'),
        eq(ticketRefs.externalSite, site),
      ),
    )
    .groupBy(ticketRefs.cachedIdentifier)
    .orderBy(desc(lastWorkedAt));
  return rows.map((row) => row.key);
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
    // ROAD-XXX (resume dead sessions), security review: these three are
    // daemon-observed FACTS, written exactly once elsewhere in this
    // codebase (cwd by startRun.ts's continueStart, worktreePath by
    // worktrees.ts's provisionWorktree, daemonWorkspaceId alongside it) and
    // never legitimately rewritten after — resumeRun only ever reads them.
    // Write-once regardless of the run's current status: the isTerminal
    // guard right below stops applying the instant a run leaves a terminal
    // status (e.g. reopenRun reviving it to `provisioning`), and cwd/
    // worktreePath are handed straight to the agent process as its
    // execution directory — a caller who could rewrite them on a
    // non-terminal row could redirect a live agent anywhere on disk.
    for (const key of ['cwd', 'worktreePath', 'daemonWorkspaceId'] as const) {
      if (fields[key] !== undefined && current[key] !== null && fields[key] !== current[key]) {
        throw new ConflictError(`${key} cannot be changed once set.`);
      }
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
      // A continuation reaching `running` again (reopenRun set
      // lastReopenedAt on its way to provisioning) is no longer ended;
      // reopenRun itself leaves endedAt alone so a reopen that never gets
      // this far still says when the run last stopped.
      if (status === 'running' && current.status === 'provisioning' && current.lastReopenedAt !== null) {
        patch.endedAt = null;
      }
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

export interface ReopenRunResult {
  run: AgentRun;
  from: AgentRunStatus;
}

/**
 * Continue a run that is not live — needs-review, done, interrupted,
 * failed, cancelled — back to `provisioning`, so `startRun.ts` can hand
 * its still-recorded `worktreePath`/`providerSessionId` back to the daemon
 * (or recreate the worktree, or start fresh). The one way past this: not a
 * wider PATCH — `updateRun` above still refuses every other patch to a
 * terminal row unconditionally, and `runStatusMachine.ts`'s TRANSITIONS
 * table was deliberately left untouched (see its isRevivable doc comment).
 *
 * Never-lock (2026-09-20): a conversation is never refused. The only
 * preconditions are the workspace (a read-scope rule) and the owner
 * (continuing starts a process on someone's machine, in their worktree —
 * a teammate's message reaches the owner's Waypoint through the run's
 * pending-prompts outbox instead). What this function used to refuse —
 * a successful ending, a run superseded by a retry, a second live writer
 * on the ticket, a reopen cooldown and cap — is gone on purpose:
 *
 *  - many conversations may be live on one ticket at once (parity with
 *    emdash, where a task has any number of conversations). What stays
 *    single is the *automatic dispatch* of a ticket (createRun's advisory
 *    lock) and the *publisher* (claimPublish below) — a person talking to
 *    an old run is neither;
 *  - a superseded run is still a conversation someone may want to reopen
 *    to ask what it did; the retry that replaced it does its own work on
 *    its own branch;
 *  - the rate limit protected against a runaway automatic resume loop;
 *    that guard now lives where the automation is (the outbox's
 *    `autoAttempts`), not in front of a person's message.
 *
 * `endedAt` is left alone here and cleared by `updateRun` once the
 * continuation actually reaches `running` (see the `provisioning →
 * running` clause there), so a reopen that never completes still carries
 * when this run last stopped. `reopenCount`/`lastReopenedAt` are kept as
 * facts about the row, no longer as a throttle.
 */
export async function reopenRun(runId: string, reason?: string): Promise<ReopenRunResult> {
  return db.transaction(async (tx) => {
    // Peeked unlocked, only to decide whether a ticket-scoped advisory
    // lock is needed — every authoritative check still happens below,
    // after the row lock. Advisory → row, the same order createRun and
    // claimPublish use, so this can never deadlock against either.
    //
    // Found in review (round 2): without this, reopenRun could revive a
    // dispatched run on a ticket in the same window createRun or
    // claimPublish decides — under their own advisory lock — that the
    // ticket has no live writer, landing two dispatched writers on one
    // ticket at once. That's exactly the race those callers' own checks
    // exist to prevent; reopenRun just wasn't holding the same lock they
    // serialize on.
    //
    // Found in review (round 4): the decision is made from an UNLOCKED
    // read, so it may only depend on fields that cannot change between
    // this peek and the row lock below. `entry` and `ticketId` are
    // create-only (updateAgentRunSchema has neither); `modeId` is not —
    // a plan-mode run patched to a writing mode in that window used to
    // slip past the lock entirely, since the peek had already decided
    // no lock was needed. So unlike createRun (whose input is its own
    // and can't move under it), every dispatched ticketed run takes the
    // lock here, plan-mode or not: a needless lock on a plan run costs a
    // moment; a missing one costs the invariant.
    const [peek] = await tx
      .select({ ticketId: agentRuns.ticketId, entry: agentRuns.entry })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    if (!peek) throw new NotFoundError('agent run');
    const dispatchTicketId = peek.entry === 'dispatched' && peek.ticketId ? peek.ticketId : null;
    if (dispatchTicketId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${dispatchTicketId}))`);
    }

    const current = await lockRun(tx, runId);

    // Scoped inside the transaction, not at the route (unlike most bare-id
    // routes): reopenRun has no request-less caller — unlike updateRun's
    // settleRunIfDecided sweep — so there's no reason to accept the TOCTOU
    // window a pre-transaction check would leave.
    if ((await ownerWorkspaceId(tx, current.ownerMemberId)) !== currentWorkspaceId()) {
      throw new NotFoundError('agent run');
    }
    if (current.ownerMemberId !== currentMemberId()) {
      throw new ConflictError(`Run ${runId} belongs to another member; only its owner can resume it.`);
    }
    if (!isRevivable(current.status)) {
      // Only a live status reaches here — nothing to reopen; the caller
      // sends to the live session instead.
      throw new ConflictError(`Run ${runId} is ${current.status}; it is live, not something to reopen.`);
    }

    const now = new Date();
    const [updated] = await tx
      .update(agentRuns)
      .set({
        status: 'provisioning',
        reopenCount: current.reopenCount + 1,
        lastReopenedAt: now,
        updatedAt: now,
      })
      .where(eq(agentRuns.id, runId))
      .returning();

    await writeEvent(tx, runId, 'run_reopened', {
      from: current.status,
      errorKind: current.errorKind,
      errorMessage: current.errorMessage,
      ...(reason !== undefined ? { reason } : {}),
    });
    await writeEvent(tx, runId, 'status_changed', { from: current.status, to: 'provisioning' });

    return { run: updated, from: current.status };
  });
}

export interface PublishClaimResult {
  run: AgentRun;
  /** The claim that now holds the ticket, for the caller's trail. */
  claimedAt: Date;
}

/**
 * At most one publisher per ticket at publish time (never-lock, 2026-09-20,
 * §3.3b of the design). Many conversations may be live on one ticket; the
 * one thing that must stay single is who pushes the branch and opens or
 * updates the PR. Called by the host's finalize right before it publishes,
 * and by the header's Open PR. Two distinct mechanisms — do not conflate:
 *
 *  (i) the in-transaction race: `pg_advisory_xact_lock(hashtext(ticketId))`
 *      — the same key createRun takes, in the same order (advisory, then
 *      the row). Two claims for one ticket, from any number of backend
 *      processes, serialize here; the second's select runs after the
 *      first committed. Released with the transaction; it needs no expiry
 *      and never outlives a request.
 *
 *  (ii) a claimant that died mid-push: lock-free, by the trail. Another
 *      dispatched writer on the ticket that is live, or whose latest
 *      `publish_claimed` is newer than its latest `finalized` AND younger
 *      than PUBLISH_CLAIM_TTL_MS, holds the ticket. The TTL applies to
 *      this check only — it is how a claim left behind by a host that
 *      died between claim and push stops blocking other publishers.
 *
 * A refusal is a ConflictError naming the writer; the host files its
 * comment unpublished and the transcript marker says how to retry. Never
 * a status move.
 */
export async function claimPublish(runId: string, headSha: string | null): Promise<PublishClaimResult> {
  return db.transaction(async (tx) => {
    const [peek] = await tx
      .select({ ticketId: agentRuns.ticketId, ownerMemberId: agentRuns.ownerMemberId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    if (!peek || (await ownerWorkspaceId(tx, peek.ownerMemberId)) !== currentWorkspaceId()) {
      throw new NotFoundError('agent run');
    }
    if (peek.ticketId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${peek.ticketId}))`);
    }
    const current = await lockRun(tx, runId);
    if (current.ownerMemberId !== currentMemberId()) {
      throw new ConflictError(`Run ${runId} belongs to another member; only its owner can publish it.`);
    }
    const now = new Date();
    if (current.ticketId && current.entry === 'dispatched') {
      const [live] = await tx
        .select({ id: agentRuns.id, title: agentRuns.title })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.ticketId, current.ticketId),
            eq(agentRuns.entry, 'dispatched'),
            ne(agentRuns.id, runId),
            inArray(agentRuns.status, [...LIVE_RUN_STATUSES]),
            or(isNull(agentRuns.modeId), ne(agentRuns.modeId, 'plan')),
          ),
        )
        .limit(1);
      if (live) {
        throw new ConflictError(`Not published: this ticket has a live writer (${live.title ?? live.id}).`);
      }
      // ISO text, not a Date: postgres-js's raw `sql` tag binds a Date as bytes.
      const since = new Date(now.getTime() - PUBLISH_CLAIM_TTL_MS).toISOString();
      const [claimed] = await tx.execute<{ run_id: string; title: string | null }>(sql`
        SELECT c.run_id, r.title
        FROM ${agentRunEvents} c
        JOIN ${agentRuns} r ON r.id = c.run_id
        WHERE c.kind = 'publish_claimed'
          AND c.run_id <> ${runId}
          AND r.ticket_id = ${current.ticketId}
          AND r.entry = 'dispatched'
          AND c.at > ${since}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM ${agentRunEvents} f
            WHERE f.run_id = c.run_id AND f.kind = 'finalized' AND f.seq > c.seq
          )
        ORDER BY c.at DESC
        LIMIT 1
      `);
      if (claimed) {
        throw new ConflictError(
          `Not published: this ticket has a live writer (${claimed.title ?? claimed.run_id}); its publish is in progress.`,
        );
      }
    }
    await writeEvent(tx, runId, 'publish_claimed', {
      headSha,
      ticketId: current.ticketId,
      by: currentMemberId(),
    });
    return { run: current, claimedAt: now };
  });
}
