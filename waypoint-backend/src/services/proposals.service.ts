import { eq, and, lt, count, inArray, asc, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { copilotProposals, copilotConversations, copilotMessages, workItems } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { NotFoundError } from '../middleware/errors.js';
import { buildCopilotCommentHtml, COPILOT_DISCLOSURE } from '../lib/commentHtml.js';
import * as workItemsService from './workItems.service.js';
import * as commentsService from './comments.service.js';
import * as statesService from './states.service.js';
import * as membersService from './members.service.js';
import * as projectsService from './projects.service.js';

// A proposal the user hasn't acted on within a day is more likely to be
// forgotten context than a still-wanted change — approve refuses it (and
// listProposals lazily finalizes it) rather than executing against a
// day-old snapshot of reality.
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
// Per-turn cap: anchorSeq identifies a turn (every proposal in one model
// turn shares the max message seq at propose time), so counting rows with
// the same (conversationId, anchorSeq) counts this turn's proposals.
export const MAX_PROPOSALS_PER_TURN = 10;
// Backstop across turns — a conversation drowning in un-reviewed cards is a
// UX failure the model should route around by asking the user to act first.
export const MAX_PENDING_PER_CONVERSATION = 20;

// A claim that's been sitting in 'executing' longer than this is a crashed
// execute (the process died between claim and finalize), not one in flight
// — real executions are single-digit-millisecond service calls. listProposals
// reverts such rows to 'proposed' so the card becomes approvable again.
const EXECUTING_STUCK_MS = 60 * 1000;

// Distinct from NotFoundError/ConflictError: this is a model-facing
// validation failure — the MCP propose handlers catch it and return its
// message verbatim as an isError tool result, instead of the generic
// internal-error scrub withErrorSafetyNet applies to everything else.
export class ProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalValidationError';
  }
}

export type ProposalKind = 'comment' | 'state_change' | 'assignee_change' | 'priority_change' | 'create_work_item';
export type ProposalStatus = 'proposed' | 'executing' | 'executed' | 'rejected' | 'stale' | 'expired' | 'superseded';

type Priority = NonNullable<(typeof workItems.$inferInsert)['priority']>;

export interface CreateWorkItemProposalPayload {
  projectId: string;
  title: string;
  description?: string;
  // Always concrete by the time a proposal row exists — the propose handler
  // resolves the project's default state when the model omits one.
  stateId: string;
  priority?: Priority;
  assigneeIds?: string[];
  dueDate?: string;
}

export type ProposalPayload =
  | { body: string } // comment
  | { stateId: string } // state_change
  | { priority: Priority } // priority_change
  | { assigneeId: string; action: 'add' | 'remove' } // assignee_change
  | CreateWorkItemProposalPayload; // create_work_item

// Everything the card needs to render (names/colors, never bare ids) plus
// the from-values approve re-checks the live row against. Captured at
// propose time; deliberately NOT refreshed by listProposals — staleness is
// authoritative at approve only.
export type ProposalSnapshot = Record<string, unknown>;

export interface CreateProposalInput {
  conversationId: string;
  kind: ProposalKind;
  workItemId: string | null;
  payload: ProposalPayload;
  snapshot: ProposalSnapshot;
}

type ProposalRow = typeof copilotProposals.$inferSelect;

export interface ProposalView {
  id: string;
  conversationId: string;
  kind: ProposalKind;
  workItemId: string | null;
  payload: ProposalPayload;
  snapshot: ProposalSnapshot;
  anchorSeq: number;
  status: ProposalStatus;
  statusReason: string | null;
  resultInfo: unknown;
  // The exact self-disclosure prefix a comment will carry if approved —
  // computed from the CURRENT user's display name at read time so the card
  // preview always matches what addComment would actually write.
  disclosureText: string;
  expiresAt: Date;
  modelNotifiedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

function toView(row: ProposalRow, displayName: string): ProposalView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind as ProposalKind,
    workItemId: row.workItemId,
    payload: row.payload as ProposalPayload,
    snapshot: row.snapshot as ProposalSnapshot,
    anchorSeq: Number(row.anchorSeq),
    status: row.status as ProposalStatus,
    statusReason: row.statusReason,
    resultInfo: row.resultInfo,
    disclosureText: COPILOT_DISCLOSURE(displayName),
    expiresAt: row.expiresAt,
    modelNotifiedAt: row.modelNotifiedAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

export async function createProposal(input: CreateProposalInput): Promise<ProposalRow> {
  const { conversationId, kind, workItemId, payload, snapshot } = input;
  return db.transaction(async (tx) => {
    // Existence check inside the same transaction — a bogus conversationId
    // (the header is attacker-influencable in principle) must 404-shape
    // fail, not surface as a raw FK violation.
    const [conversation] = await tx
      .select({ id: copilotConversations.id })
      .from(copilotConversations)
      .where(eq(copilotConversations.id, conversationId))
      .limit(1);
    if (!conversation) throw new NotFoundError('conversation');

    // max(seq) at propose time anchors the card after the turn that
    // proposed it. sql-level max, not a fetch-and-reduce — one row back
    // regardless of conversation length. postgres-js returns bigint
    // aggregates as strings, hence the Number().
    const [{ maxSeq }] = await tx
      .select({ maxSeq: sql<string | number | null>`max(${copilotMessages.seq})` })
      .from(copilotMessages)
      .where(eq(copilotMessages.conversationId, conversationId));
    const anchorSeq = maxSeq == null ? 0 : Number(maxSeq);

    // Caps — checked before the supersede pass so a superseding proposal
    // can't slip under the turn cap by first freeing its predecessor.
    const [{ n: turnCount }] = await tx
      .select({ n: count() })
      .from(copilotProposals)
      .where(and(eq(copilotProposals.conversationId, conversationId), eq(copilotProposals.anchorSeq, anchorSeq)));
    if (turnCount >= MAX_PROPOSALS_PER_TURN) {
      throw new ProposalValidationError(
        `Too many proposals this turn (max ${MAX_PROPOSALS_PER_TURN}) — ask the user to act on the pending ones first.`,
      );
    }
    const [{ n: pendingCount }] = await tx
      .select({ n: count() })
      .from(copilotProposals)
      .where(and(eq(copilotProposals.conversationId, conversationId), eq(copilotProposals.status, 'proposed')));
    if (pendingCount >= MAX_PENDING_PER_CONVERSATION) {
      throw new ProposalValidationError(
        `Too many pending proposals in this conversation (max ${MAX_PENDING_PER_CONVERSATION}) — ask the user to approve or reject the pending ones first.`,
      );
    }

    // Supersede: a newer state/priority proposal for the same ticket
    // replaces any still-pending one — two pending "move LAUNCH-3 to X"
    // cards would race each other at approve time. Assignee proposals only
    // supersede when they target the SAME person (add Priya then remove
    // Priya), matched on the stored payload's assigneeId since it isn't a
    // column. Comments and creates are additive by nature — several can
    // legitimately coexist — so they never supersede.
    if (kind === 'state_change' || kind === 'priority_change' || kind === 'assignee_change') {
      const conditions = [
        eq(copilotProposals.conversationId, conversationId),
        eq(copilotProposals.workItemId, workItemId as string),
        eq(copilotProposals.kind, kind),
        eq(copilotProposals.status, 'proposed'),
      ];
      if (kind === 'assignee_change') {
        conditions.push(
          sql`${copilotProposals.payload}->>'assigneeId' = ${(payload as { assigneeId: string }).assigneeId}`,
        );
      }
      await tx
        .update(copilotProposals)
        .set({ status: 'superseded', resolvedAt: new Date() })
        .where(and(...conditions));
    }

    const [row] = await tx
      .insert(copilotProposals)
      .values({
        id: newId('prop'),
        conversationId,
        kind,
        workItemId,
        payload,
        snapshot,
        anchorSeq,
        expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
      })
      .returning();
    return row;
  });
}

export async function listProposals(conversationId: string): Promise<ProposalView[]> {
  // Lazy repair pass, so the list never renders a card whose status the DB
  // knows is a lie:
  //  - a 'proposed' row past its TTL becomes 'expired' here rather than
  //    waiting for an approve attempt to discover it;
  //  - an 'executing' row stuck past EXECUTING_STUCK_MS is a crashed
  //    execute — reverted to 'proposed' so it's approvable again. The claim
  //    timestamp is resolvedAt (set by approveProposal's claim UPDATE and
  //    cleared again on revert — an 'executing' row is by definition not
  //    resolved, so the column is unambiguous while in that state).
  const now = new Date();
  await db
    .update(copilotProposals)
    .set({
      status: 'expired',
      statusReason: 'This proposal expired before it was reviewed',
      resolvedAt: now,
    })
    .where(
      and(
        eq(copilotProposals.conversationId, conversationId),
        eq(copilotProposals.status, 'proposed'),
        lt(copilotProposals.expiresAt, now),
      ),
    );
  await db
    .update(copilotProposals)
    .set({ status: 'proposed', resolvedAt: null })
    .where(
      and(
        eq(copilotProposals.conversationId, conversationId),
        eq(copilotProposals.status, 'executing'),
        lt(copilotProposals.resolvedAt, new Date(now.getTime() - EXECUTING_STUCK_MS)),
      ),
    );

  const rows = await db
    .select()
    .from(copilotProposals)
    .where(eq(copilotProposals.conversationId, conversationId))
    .orderBy(asc(copilotProposals.createdAt));
  // No live staleness checks here — the card renders the propose-time
  // snapshot, and only approve (the moment that matters) re-checks reality.
  const { displayName } = await membersService.getCurrentUser();
  return rows.map((row) => toView(row, displayName));
}

interface StaleResult {
  stale: true;
  reason: string;
}

// Fresh reads against live data, run AFTER the claim so a passing check is
// as close to execution as this design gets (ms-scale TOCTOU accepted — see
// the architecture notes; refactoring the underlying service signatures for
// perfect atomicity was explicitly ruled out).
async function checkStaleness(row: ProposalRow): Promise<StaleResult | null> {
  const kind = row.kind as ProposalKind;
  const snapshot = row.snapshot as Record<string, unknown>;

  if (kind === 'create_work_item') {
    const payload = row.payload as CreateWorkItemProposalPayload;
    const project = await projectsService.getProject(payload.projectId);
    if (!project) return { stale: true, reason: 'This project is no longer available' };
    const states = await statesService.listStates(payload.projectId);
    if (!states.some((s) => s.id === payload.stateId)) {
      return { stale: true, reason: 'The proposed state no longer exists in this project' };
    }
    // Assignee resolvability is left to createWorkItem's own
    // validateAssigneeIds — the final authority either way.
    return null;
  }

  const item = row.workItemId ? await workItemsService.getWorkItem(row.workItemId) : undefined;
  if (!item || item.isDraft) return { stale: true, reason: 'This ticket is no longer available' };

  if (kind === 'state_change') {
    if (item.stateId !== snapshot.fromStateId) {
      return { stale: true, reason: 'This ticket changed since Copilot proposed this — ask again' };
    }
    const payload = row.payload as { stateId: string };
    const states = await statesService.listStates(item.projectId);
    if (!states.some((s) => s.id === payload.stateId)) {
      return { stale: true, reason: 'The target state no longer exists in this project' };
    }
  }

  if (kind === 'priority_change' && item.priority !== snapshot.fromPriority) {
    return { stale: true, reason: 'This ticket changed since Copilot proposed this — ask again' };
  }

  if (kind === 'assignee_change') {
    // Direction guard, not just a changed-check: toggleWorkItemAssignee
    // flips whatever the current state is, so approving an "add" once the
    // person is already assigned would silently REMOVE them. The guard
    // makes the toggle semantically a checked add/remove.
    const { assigneeId, action } = row.payload as { assigneeId: string; action: 'add' | 'remove' };
    const present = item.assigneeIds.includes(assigneeId);
    if (action === 'add' && present) {
      return { stale: true, reason: 'This person is already assigned to this ticket' };
    }
    if (action === 'remove' && !present) {
      return { stale: true, reason: 'This person is not currently assigned to this ticket' };
    }
  }

  return null;
}

async function finalize(
  id: string,
  patch: { status: ProposalStatus; statusReason?: string | null; resultInfo?: unknown },
): Promise<ProposalRow> {
  const [row] = await db
    .update(copilotProposals)
    .set({ ...patch, resolvedAt: new Date() })
    .where(eq(copilotProposals.id, id))
    .returning();
  return row;
}

async function executeProposal(row: ProposalRow, displayName: string): Promise<unknown> {
  const kind = row.kind as ProposalKind;
  switch (kind) {
    case 'comment': {
      const { body } = row.payload as { body: string };
      const comment = await commentsService.addComment(
        row.workItemId as string,
        buildCopilotCommentHtml(displayName, body),
      );
      return { commentId: comment.id };
    }
    case 'state_change': {
      const { stateId } = row.payload as { stateId: string };
      await workItemsService.updateWorkItem(row.workItemId as string, { stateId });
      return null;
    }
    case 'priority_change': {
      const { priority } = row.payload as { priority: Priority };
      await workItemsService.updateWorkItem(row.workItemId as string, { priority });
      return null;
    }
    case 'assignee_change': {
      const { assigneeId } = row.payload as { assigneeId: string };
      await workItemsService.toggleWorkItemAssignee(row.workItemId as string, assigneeId);
      return null;
    }
    case 'create_work_item': {
      const payload = row.payload as CreateWorkItemProposalPayload;
      const created = await workItemsService.createWorkItem({
        projectId: payload.projectId,
        title: payload.title,
        description: payload.description,
        stateId: payload.stateId,
        priority: payload.priority,
        assigneeIds: payload.assigneeIds,
        isDraft: false,
      });
      if (payload.dueDate) {
        await workItemsService.updateWorkItem(created.id, { dueDate: payload.dueDate });
      }
      return { workItemId: created.id, identifier: created.identifier };
    }
    default:
      throw new Error(`unknown proposal kind: ${String(kind)}`);
  }
}

export async function approveProposal(id: string): Promise<ProposalView> {
  const { displayName } = await membersService.getCurrentUser();

  // Claim: the conditional UPDATE is the single-execution guarantee — of N
  // concurrent approves, exactly one sees its status still 'proposed' and
  // wins the row; everyone else falls through to the idempotent echo below.
  // resolvedAt doubles as the claim timestamp while status='executing' (see
  // listProposals's stuck-claim recovery).
  const [claimed] = await db
    .update(copilotProposals)
    .set({ status: 'executing', resolvedAt: new Date() })
    .where(and(eq(copilotProposals.id, id), eq(copilotProposals.status, 'proposed')))
    .returning();

  if (!claimed) {
    // Not claimable: either the row doesn't exist (404) or it's already
    // resolved / being executed — echo it as-is with HTTP 200 and ZERO
    // re-execution, so a double-click or a retried request is harmless.
    const [existing] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, id)).limit(1);
    if (!existing) throw new NotFoundError('proposal');
    return toView(existing, displayName);
  }

  // TTL, checked on the claimed row so an expired proposal finalizes as
  // 'expired' rather than executing a day-old intent.
  if (claimed.expiresAt.getTime() < Date.now()) {
    const finalized = await finalize(id, {
      status: 'expired',
      statusReason: 'This proposal expired before it was approved',
    });
    return toView(finalized, displayName);
  }

  const staleness = await checkStaleness(claimed);
  if (staleness) {
    // HTTP 200 with status 'stale' — the status field IS the result; the
    // card re-renders it as a blocked/stale banner, not an error toast.
    const finalized = await finalize(id, { status: 'stale', statusReason: staleness.reason });
    return toView(finalized, displayName);
  }

  let resultInfo: unknown;
  try {
    resultInfo = await executeProposal(claimed, displayName);
  } catch (error) {
    // Execution failed — release the claim so the card stays pending and
    // approve is retryable, then let errorHandler shape the HTTP response.
    await db
      .update(copilotProposals)
      .set({ status: 'proposed', resolvedAt: null })
      .where(and(eq(copilotProposals.id, id), eq(copilotProposals.status, 'executing')));
    throw error;
  }

  const finalized = await finalize(id, { status: 'executed', statusReason: null, resultInfo });
  return toView(finalized, displayName);
}

export async function rejectProposal(id: string): Promise<ProposalView> {
  const { displayName } = await membersService.getCurrentUser();
  // 'stale' is rejectable too — dismissing a stale card finalizes it as
  // rejected. statusReason is deliberately not touched, so a stale card's
  // reason survives into the rejected row (and the model's outcome note).
  const [updated] = await db
    .update(copilotProposals)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(and(eq(copilotProposals.id, id), inArray(copilotProposals.status, ['proposed', 'stale'])))
    .returning();
  if (updated) return toView(updated, displayName);
  const [existing] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, id)).limit(1);
  if (!existing) throw new NotFoundError('proposal');
  // Already resolved — idempotent echo, same contract as approve.
  return toView(existing, displayName);
}

export async function rejectAllPending(conversationId: string): Promise<{ rejected: number }> {
  const rows = await db
    .update(copilotProposals)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(and(eq(copilotProposals.conversationId, conversationId), eq(copilotProposals.status, 'proposed')))
    .returning({ id: copilotProposals.id });
  return { rejected: rows.length };
}

export async function markProposalsNotified(
  conversationId: string,
  ids: string[],
): Promise<{ notified: number }> {
  // conversationId in the WHERE, not just the ids: the route is scoped to a
  // conversation, so an id belonging to a different conversation must be a
  // silent no-op, not a cross-conversation write. modelNotifiedAt IS NULL
  // keeps the first delivery timestamp authoritative under re-delivery.
  const rows = await db
    .update(copilotProposals)
    .set({ modelNotifiedAt: new Date() })
    .where(
      and(
        inArray(copilotProposals.id, ids),
        eq(copilotProposals.conversationId, conversationId),
        isNull(copilotProposals.modelNotifiedAt),
      ),
    )
    .returning({ id: copilotProposals.id });
  return { notified: rows.length };
}
