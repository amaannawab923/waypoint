import { eq, and, or, lt, gte, desc, count, countDistinct, inArray, asc, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { proposals, copilotConversations, copilotMessages, tickets } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { NotFoundError, ValidationError } from '../middleware/errors.js';
import { buildCopilotCommentHtml, COPILOT_DISCLOSURE } from '../lib/commentHtml.js';
import * as ticketsService from './tickets.service.js';
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

// 'add_label' added for W3.1 (architecture §4.2) — no propose_add_label MCP
// tool exists yet, so nothing currently produces this kind; it's here so
// the type matches the widened proposal_kind enum.
export type ProposalKind =
  | 'comment'
  | 'state_change'
  | 'assignee_change'
  | 'priority_change'
  | 'create_ticket'
  | 'add_label';
// 'reverted' added for W3.1 — the Undo path (architecture §4.5) that
// produces it is a later P4 unit, not built here.
export type ProposalStatus =
  | 'proposed'
  | 'executing'
  | 'executed'
  | 'rejected'
  | 'stale'
  | 'expired'
  | 'superseded'
  | 'reverted';
// Terminal statuses only — used by the review queue's "recent" segment and
// the sidebar's resolved-in-24h count. 'executing' is deliberately
// excluded: resolvedAt doubles as its claim timestamp (see EXECUTING_STUCK_MS
// above), so a row mid-claim must never be counted as "resolved".
const TERMINAL_PROPOSAL_STATUSES: ProposalStatus[] = [
  'executed',
  'rejected',
  'stale',
  'expired',
  'superseded',
  'reverted',
];

export type ProposalOrigin = 'copilot' | 'agent_run';
export type ProposalDecidedBy = 'user' | 'trust_grant' | 'system';

type Priority = NonNullable<(typeof tickets.$inferInsert)['priority']>;

export interface CreateTicketProposalPayload {
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
  | CreateTicketProposalPayload; // create_ticket

// Everything the card needs to render (names/colors, never bare ids) plus
// the from-values approve re-checks the live row against. Captured at
// propose time; deliberately NOT refreshed by listProposals — staleness is
// authoritative at approve only.
export type ProposalSnapshot = Record<string, unknown>;

export interface CreateProposalInput {
  conversationId: string;
  kind: ProposalKind;
  ticketId: string | null;
  payload: ProposalPayload;
  snapshot: ProposalSnapshot;
}

type ProposalRow = typeof proposals.$inferSelect;

export interface ProposalView {
  id: string;
  // NOW NULLABLE — non-null only for origin='copilot' (see schema note).
  conversationId: string | null;
  kind: ProposalKind;
  ticketId: string | null;
  payload: ProposalPayload;
  snapshot: ProposalSnapshot;
  // NOW NULLABLE — non-null only for origin='copilot'.
  anchorSeq: number | null;
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
  // --- new for W3.1's workspace-scoped widening -------------------------
  origin: ProposalOrigin;
  projectId: string;
  agentId: string | null;
  agentRunId: string | null;
  sourceRequestId: string | null;
  decidedBy: ProposalDecidedBy | null;
  trustGrantId: string | null;
  decisionLatencyMs: number | null;
}

function toView(row: ProposalRow, displayName: string): ProposalView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind as ProposalKind,
    ticketId: row.ticketId,
    payload: row.payload as ProposalPayload,
    snapshot: row.snapshot as ProposalSnapshot,
    anchorSeq: row.anchorSeq == null ? null : Number(row.anchorSeq),
    status: row.status as ProposalStatus,
    statusReason: row.statusReason,
    resultInfo: row.resultInfo,
    disclosureText: COPILOT_DISCLOSURE(displayName),
    expiresAt: row.expiresAt,
    modelNotifiedAt: row.modelNotifiedAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    origin: row.origin as ProposalOrigin,
    projectId: row.projectId,
    agentId: row.agentId,
    agentRunId: row.agentRunId,
    sourceRequestId: row.sourceRequestId,
    decidedBy: row.decidedBy as ProposalDecidedBy | null,
    trustGrantId: row.trustGrantId,
    decisionLatencyMs: row.decisionLatencyMs,
  };
}

export async function createProposal(input: CreateProposalInput): Promise<ProposalRow> {
  const { conversationId, kind, ticketId, payload, snapshot } = input;
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
      .from(proposals)
      .where(and(eq(proposals.conversationId, conversationId), eq(proposals.anchorSeq, anchorSeq)));
    if (turnCount >= MAX_PROPOSALS_PER_TURN) {
      throw new ProposalValidationError(
        `Too many proposals this turn (max ${MAX_PROPOSALS_PER_TURN}) — ask the user to act on the pending ones first.`,
      );
    }
    const [{ n: pendingCount }] = await tx
      .select({ n: count() })
      .from(proposals)
      .where(and(eq(proposals.conversationId, conversationId), eq(proposals.status, 'proposed')));
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
        eq(proposals.conversationId, conversationId),
        eq(proposals.ticketId, ticketId as string),
        eq(proposals.kind, kind),
        eq(proposals.status, 'proposed'),
      ];
      if (kind === 'assignee_change') {
        conditions.push(
          sql`${proposals.payload}->>'assigneeId' = ${(payload as { assigneeId: string }).assigneeId}`,
        );
      }
      // decidedBy='system' (not null): the enum's own comment lists
      // 'superseded' under 'system' alongside expired/stale — nobody
      // clicked anything, a newer proposal for the same target replaced
      // this one automatically. decisionLatencyMs stays unset (NULL),
      // matching "NULL for system resolutions".
      await tx
        .update(proposals)
        .set({ status: 'superseded', resolvedAt: new Date(), decidedBy: 'system' })
        .where(and(...conditions));
    }

    // projectId is denormalised (architecture §4.2) so the review queue's
    // project filter is one index scan with no join. Every proposal this
    // function creates is origin='copilot', so this is the only place that
    // needs to resolve it: for create_ticket it's already in the payload
    // (there's no ticket yet); for everything else it comes from the
    // target ticket's own project. Resolved as a correlated subquery
    // inside the same INSERT — not a separate tx.select — so this doesn't
    // add a round trip or change the transaction's query shape.
    const projectId =
      kind === 'create_ticket'
        ? (payload as CreateTicketProposalPayload).projectId
        : sql`(select ${tickets.projectId} from ${tickets} where ${tickets.id} = ${ticketId})`;

    const [row] = await tx
      .insert(proposals)
      .values({
        id: newId('prop'),
        origin: 'copilot',
        conversationId,
        kind,
        ticketId,
        payload,
        snapshot,
        anchorSeq,
        // Narrow, documented escape (not `any`): drizzle accepts a raw SQL
        // fragment as a column value at runtime for a correlated-subquery
        // insert, but the generated insert type only has room for the
        // plain column type (string), so TypeScript needs this cast told
        // explicitly rather than the column's declared type being widened.
        projectId: projectId as unknown as string,
        expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
      })
      .returning();
    return row;
  });
}

// W3.3 (architecture §4.2, "the repair pass has to change shape"): this
// used to run inline inside listProposals, scoped by conversation_id. The
// aggregate review queue has no conversation id to scope a repair scan by,
// so the pass is now workspace-wide — kept cheap by the two partial
// indexes on the proposals table (proposals_pending_expiry_idx,
// proposals_stuck_claim_idx — see db/schema/proposals.ts) rather than by a
// conversation filter. Exactly the same two UPDATEs as before, just
// unscoped:
//  - a 'proposed' row past its TTL becomes 'expired' rather than waiting
//    for an approve attempt to discover it;
//  - an 'executing' row stuck past EXECUTING_STUCK_MS is a crashed OR
//    still-in-flight execute — and there is no way to tell whether the
//    crash happened BEFORE or AFTER the underlying write ran (final review
//    finding M2: a process death between execute and finalize leaves a
//    comment already posted / a ticket already created). So a stuck claim
//    is parked as STALE — visible, non-approvable, with a reason telling
//    the user to check the ticket — never back to 'proposed', where one
//    more Approve click would run the write a second time. The claim
//    timestamp is resolvedAt (set by approveProposal's claim UPDATE), so
//    the column is unambiguous while in the 'executing' state.
export async function repairProposals(): Promise<void> {
  const now = new Date();
  // Both resolutions here are system-driven — no person acted — so
  // decidedBy='system' (never 'user'), and decisionLatencyMs is left unset
  // (NULL), per the column's own "NULL for system resolutions" comment.
  await db
    .update(proposals)
    .set({
      status: 'expired',
      statusReason: 'This proposal expired before it was reviewed',
      resolvedAt: now,
      decidedBy: 'system',
    })
    .where(and(eq(proposals.status, 'proposed'), lt(proposals.expiresAt, now)));
  await db
    .update(proposals)
    .set({
      status: 'stale',
      statusReason:
        'Approval was interrupted — check the ticket before asking Copilot to propose this again.',
      resolvedAt: now,
      decidedBy: 'system',
    })
    .where(
      and(
        eq(proposals.status, 'executing'),
        lt(proposals.resolvedAt, new Date(now.getTime() - EXECUTING_STUCK_MS)),
      ),
    );
}

// The primary schedule for repairProposals is a 60-second setInterval in
// index.ts. This is the belt-and-braces fallback for callers (listProposals
// below) between ticks — guarded by a module-level "last repaired at" so a
// burst of calls inside the same minute runs the repair query pair at most
// once, rather than once per call.
const REPAIR_INTERVAL_MS = 60 * 1000;
let lastRepairedAt = 0;

export async function maybeRepairProposals(): Promise<void> {
  const now = Date.now();
  if (now - lastRepairedAt < REPAIR_INTERVAL_MS) return;
  lastRepairedAt = now;
  await repairProposals();
}

export async function listProposals(conversationId: string): Promise<ProposalView[]> {
  // See maybeRepairProposals/repairProposals above — this used to be two
  // inline, conversation-scoped UPDATEs run on every call.
  await maybeRepairProposals();

  const rows = await db
    .select()
    .from(proposals)
    .where(eq(proposals.conversationId, conversationId))
    .orderBy(asc(proposals.createdAt));
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

  if (kind === 'create_ticket') {
    const payload = row.payload as CreateTicketProposalPayload;
    const project = await projectsService.getProject(payload.projectId);
    // getProject has no archived filter of its own (unlike listProjects) —
    // a project archived between propose and approve must re-check as
    // stale too, same reason/wording as a deleted project, so an approve
    // can't slip a ticket into a project no UI list surfaces anymore.
    if (!project || project.archivedAt) {
      return { stale: true, reason: 'This project is no longer available' };
    }
    const states = await statesService.listStates(payload.projectId);
    if (!states.some((s) => s.id === payload.stateId)) {
      return { stale: true, reason: 'The proposed state no longer exists in this project' };
    }
    // Assignee resolvability is left to createTicket's own
    // validateAssigneeIds — the final authority either way.
    return null;
  }

  const item = row.ticketId ? await ticketsService.getTicket(row.ticketId) : undefined;
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
    // Direction guard, not just a changed-check: toggleTicketAssignee
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
  patch: {
    status: ProposalStatus;
    statusReason?: string | null;
    resultInfo?: unknown;
    // W4.5 (architecture §4.2, decision 10): decision provenance, stamped
    // by every caller below — 'user' only for a genuine executed outcome,
    // 'system' for expired/stale (decisionLatencyMs omitted so it stays
    // NULL, per the column's own comment).
    decidedBy?: ProposalDecidedBy;
    decisionLatencyMs?: number;
  },
): Promise<ProposalRow> {
  // Guarded on status='executing' (final review finding M2): only the
  // holder of a live claim may finalize. Without this, a slow execute that
  // outlived the stuck-claim repair (which parks the row as stale) would
  // stomp that resolution with 'executed' — or worse, overwrite whatever a
  // second approve produced. A lost claim falls through to the fetch below
  // and returns the row as the repair left it, rather than rewriting
  // history.
  const [row] = await db
    .update(proposals)
    .set({ ...patch, resolvedAt: new Date() })
    .where(and(eq(proposals.id, id), eq(proposals.status, 'executing')))
    .returning();
  if (row) return row;
  const [current] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id));
  return current;
}

async function executeProposal(row: ProposalRow, displayName: string): Promise<unknown> {
  const kind = row.kind as ProposalKind;
  switch (kind) {
    case 'comment': {
      const { body } = row.payload as { body: string };
      const comment = await commentsService.addComment(
        row.ticketId as string,
        buildCopilotCommentHtml(displayName, body),
      );
      return { commentId: comment.id };
    }
    case 'state_change': {
      const { stateId } = row.payload as { stateId: string };
      await ticketsService.updateTicket(row.ticketId as string, { stateId });
      return null;
    }
    case 'priority_change': {
      const { priority } = row.payload as { priority: Priority };
      await ticketsService.updateTicket(row.ticketId as string, { priority });
      return null;
    }
    case 'assignee_change': {
      const { assigneeId } = row.payload as { assigneeId: string };
      await ticketsService.toggleTicketAssignee(row.ticketId as string, assigneeId);
      return null;
    }
    case 'create_ticket': {
      const payload = row.payload as CreateTicketProposalPayload;
      const created = await ticketsService.createTicket({
        projectId: payload.projectId,
        title: payload.title,
        description: payload.description,
        stateId: payload.stateId,
        priority: payload.priority,
        assigneeIds: payload.assigneeIds,
        isDraft: false,
      });
      if (payload.dueDate) {
        await ticketsService.updateTicket(created.id, { dueDate: payload.dueDate });
      }
      return { ticketId: created.id, identifier: created.identifier };
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
    .update(proposals)
    .set({ status: 'executing', resolvedAt: new Date() })
    .where(and(eq(proposals.id, id), eq(proposals.status, 'proposed')))
    .returning();

  if (!claimed) {
    // Not claimable: either the row doesn't exist (404) or it's already
    // resolved / being executed — echo it as-is with HTTP 200 and ZERO
    // re-execution, so a double-click or a retried request is harmless.
    const [existing] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    if (!existing) throw new NotFoundError('proposal');
    return toView(existing, displayName);
  }

  // TTL, checked on the claimed row so an expired proposal finalizes as
  // 'expired' rather than executing a day-old intent. Nobody decided this —
  // the clock did — so decidedBy='system', not 'user', and no
  // decisionLatencyMs (see the enum/column comments in db/schema/proposals.ts).
  if (claimed.expiresAt.getTime() < Date.now()) {
    const finalized = await finalize(id, {
      status: 'expired',
      statusReason: 'This proposal expired before it was approved',
      decidedBy: 'system',
    });
    return toView(finalized, displayName);
  }

  const staleness = await checkStaleness(claimed);
  if (staleness) {
    // HTTP 200 with status 'stale' — the status field IS the result; the
    // card re-renders it as a blocked/stale banner, not an error toast.
    // Same reasoning as the TTL branch above: staleness is reality having
    // changed, not a person's decision, so decidedBy='system'.
    const finalized = await finalize(id, {
      status: 'stale',
      statusReason: staleness.reason,
      decidedBy: 'system',
    });
    return toView(finalized, displayName);
  }

  // This IS a genuine user decision — the row survived the TTL and
  // staleness checks above, so the click that got us here is what's about
  // to execute. Captured now (right after the claim, before execution runs)
  // so decisionLatencyMs measures time-to-decision, not time-to-decision-
  // plus-execution (architecture §4.2: "wall-clock ms between the row
  // becoming visible [createdAt — modelNotifiedAt is a different marker,
  // stamped for the MODEL's benefit, not the reviewer's] and the decision").
  const decisionLatencyMs = Date.now() - claimed.createdAt.getTime();

  let resultInfo: unknown;
  try {
    resultInfo = await executeProposal(claimed, displayName);
  } catch (error) {
    // Execution failed — release the claim so the card stays pending and
    // approve is retryable, then let errorHandler shape the HTTP response.
    await db
      .update(proposals)
      .set({ status: 'proposed', resolvedAt: null })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'executing')));
    throw error;
  }

  const finalized = await finalize(id, {
    status: 'executed',
    statusReason: null,
    resultInfo,
    decidedBy: 'user',
    decisionLatencyMs,
  });
  return toView(finalized, displayName);
}

export async function rejectProposal(id: string): Promise<ProposalView> {
  const { displayName } = await membersService.getCurrentUser();
  // 'stale' is rejectable too — dismissing a stale card finalizes it as
  // rejected. statusReason is deliberately not touched, so a stale card's
  // reason survives into the rejected row (and the model's outcome note).
  // A person clicked Reject either way (a stale card's only affordance IS
  // dismiss), so decidedBy='user' regardless of the prior status.
  // decisionLatencyMs is computed in SQL against this row's OWN createdAt
  // rather than a JS Date.now() - <pre-fetched row>.createdAt, so this stays
  // one UPDATE with no read-before-write.
  const [updated] = await db
    .update(proposals)
    .set({
      status: 'rejected',
      resolvedAt: new Date(),
      decidedBy: 'user',
      decisionLatencyMs: sql`(extract(epoch from (now() - ${proposals.createdAt})) * 1000)::int`,
    })
    .where(and(eq(proposals.id, id), inArray(proposals.status, ['proposed', 'stale'])))
    .returning();
  if (updated) return toView(updated, displayName);
  const [existing] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  if (!existing) throw new NotFoundError('proposal');
  // Already resolved — idempotent echo, same contract as approve.
  return toView(existing, displayName);
}

export async function rejectAllPending(conversationId: string): Promise<{ rejected: number }> {
  // 'stale' included alongside 'proposed' (final review finding m5), matching
  // single-row rejectProposal: a stale card's only affordance is Dismiss, so
  // "reject all" leaving stale cards behind stranded them with no bulk way out.
  // Same decision-provenance stamping as rejectProposal, and for the same
  // reason: "Reject all" is still a person clicking one button, a genuine
  // decision for every row it touches — decidedBy='user',
  // decisionLatencyMs per-row from that row's own createdAt.
  const rows = await db
    .update(proposals)
    .set({
      status: 'rejected',
      resolvedAt: new Date(),
      decidedBy: 'user',
      decisionLatencyMs: sql`(extract(epoch from (now() - ${proposals.createdAt})) * 1000)::int`,
    })
    .where(
      and(
        eq(proposals.conversationId, conversationId),
        inArray(proposals.status, ['proposed', 'stale']),
      ),
    )
    .returning({ id: proposals.id });
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
    .update(proposals)
    .set({ modelNotifiedAt: new Date() })
    .where(
      and(
        inArray(proposals.id, ids),
        eq(proposals.conversationId, conversationId),
        isNull(proposals.modelNotifiedAt),
      ),
    )
    .returning({ id: proposals.id });
  return { notified: rows.length };
}

// ---------------------------------------------------------------------------
// Review queue (W3.2, architecture §4.4) — the workspace-scoped aggregate
// surface. Everything below is purely additive: it reads the same table and
// reuses approveProposal/rejectProposal verbatim, and never reimplements
// any state-machine logic above this line.
// ---------------------------------------------------------------------------

export type ReviewQueueSegment = 'proposed' | 'blocked' | 'recent';

export interface ReviewQueueParams {
  status: ReviewQueueSegment;
  agentId?: string;
  projectId?: string;
  kind?: ProposalKind;
  limit?: number;
  cursor?: string;
}

export interface ReviewQueueCounts {
  proposed: number;
  blocked: number;
  recent: number;
}

export interface ReviewQueueResult {
  proposals: ProposalView[];
  counts: ReviewQueueCounts;
  // Opaque keyset token for the next page, or null when this page is the
  // last one. Not in the architecture doc's response sketch verbatim, but
  // "keyset pagination on (created_at, id)" needs some way to hand the next
  // key back to the caller.
  nextCursor: string | null;
}

const DEFAULT_REVIEW_QUEUE_LIMIT = 25;
const MAX_REVIEW_QUEUE_LIMIT = 100;
// "recent" segment = resolved in the last 24h (architecture §4.4).
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface Cursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id }), 'utf8').toString('base64url');
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

// Counts are workspace-wide and unfiltered by the caller's agentId/
// projectId/kind — these back the segment tabs themselves (proposed /
// blocked / recent), which stay stable while a filter narrows what's
// listed inside the selected tab.
async function computeReviewQueueCounts(): Promise<ReviewQueueCounts> {
  const cutoff = new Date(Date.now() - RECENT_WINDOW_MS);
  const [{ n: proposedCount }] = await db
    .select({ n: count() })
    .from(proposals)
    .where(eq(proposals.status, 'proposed'));
  const [{ n: recentCount }] = await db
    .select({ n: count() })
    .from(proposals)
    .where(and(inArray(proposals.status, TERMINAL_PROPOSAL_STATUSES), gte(proposals.resolvedAt, cutoff)));
  return {
    proposed: proposedCount,
    // "Blocked" projects agent_runs.status='blocked' into the same card
    // shape (architecture §4.4) — agent_runs doesn't exist as a table yet
    // (agent-run infrastructure is deferred per the founder's
    // Copilot-freeze scope decision), so this is 0 rather than a query
    // against a table that isn't there.
    blocked: 0,
    recent: recentCount,
  };
}

export async function getProposalCounts(): Promise<ReviewQueueCounts> {
  return computeReviewQueueCounts();
}

// ---------------------------------------------------------------------------
// W4.5 (architecture §4.2/§4.4, waypoint-product-strategy.md decision 10):
// "Proposals approved per active day" is the metric that decides whether
// the whole propose->approve thesis is real. All-time, not a rolling
// window — neither decision 10's text nor the Analytics tile in the mockup
// (which is explicitly captioned "Counts only... nothing here interpolates
// history it does not have") names a window, and inventing one here would
// be exactly the kind of unverified specificity decision 9's honesty rule
// exists to catch. Filtered to decided_by='user' rather than just
// status='executed': the metric is about a PERSON approving something
// ("if a person approves several times a day, the product is real"), so a
// future trust-grant auto-apply must not silently inflate it.
// ---------------------------------------------------------------------------

export interface ApprovedPerActiveDayStats {
  approvedCount: number;
  activeDays: number;
  // null (not 0/NaN) when there is no data yet — the honest "not enough
  // data" state, same principle as the review-health strip's own floor.
  averagePerActiveDay: number | null;
}

export async function getApprovedPerActiveDayStats(): Promise<ApprovedPerActiveDayStats> {
  const [row] = await db
    .select({
      approvedCount: count(),
      activeDays: countDistinct(sql`date_trunc('day', ${proposals.resolvedAt})`),
    })
    .from(proposals)
    .where(and(eq(proposals.status, 'executed'), eq(proposals.decidedBy, 'user')));
  const approvedCount = row?.approvedCount ?? 0;
  const activeDays = row?.activeDays ?? 0;
  return {
    approvedCount,
    activeDays,
    averagePerActiveDay: activeDays > 0 ? approvedCount / activeDays : null,
  };
}

// ---------------------------------------------------------------------------
// W4.3 (architecture §4.4/§4.5, accept criterion): the review-health strip's
// data source. "A review queue only works in a narrow band: approve
// everything without reading and human-in-the-loop is theatre; reject
// everything and it's a chore" — so the strip instruments the DECISION
// (approval rate + time-to-decide), not just throughput.
//
// All-time, not a rolling window — same reasoning as
// getApprovedPerActiveDayStats just above: neither §4.4/§4.5 nor the W4.3
// accept criterion names a window (the mockup's "this week" label is
// explicitly flagged elsewhere in this codebase as unverified placeholder
// text), and inventing one here would be exactly the kind of unverified
// specificity the honesty rule (decision 9) exists to catch. If the founder
// wants a rolling window later, that is a deliberate, named decision, not a
// default this function should guess at.
//
// decided_by='user' only, same filter as the per-active-day stats: an
// auto-applied (trust_grant) decision must never count as evidence that a
// human is doing real review. status IN ('executed','rejected') rather than
// "decisionLatencyMs IS NOT NULL" — the column comment already guarantees
// every decided_by='user' row in those two statuses has it set; being
// explicit about the statuses keeps this function's own field readable
// without relying on that guarantee silently.
// ---------------------------------------------------------------------------

// Accept criterion, verbatim: "the health strip shows 'not enough decisions
// yet' below 10 decisions; above it, both the rate and the median come from
// stored decision_latency_ms."
const MIN_HEALTH_DECISIONS = 10;

export interface ReviewHealthStats {
  decisionCount: number;
  // null (not 0/NaN) below MIN_HEALTH_DECISIONS — the same "honest null"
  // shape as ApprovedPerActiveDayStats.averagePerActiveDay above.
  approvalRate: number | null;
  medianDecisionMs: number | null;
}

export async function getReviewHealthStats(): Promise<ReviewHealthStats> {
  const [row] = await db
    .select({
      executed: sql<string | number>`count(*) filter (where ${proposals.status} = 'executed')`,
      rejected: sql<string | number>`count(*) filter (where ${proposals.status} = 'rejected')`,
      // percentile_cont interpolates between the two middle values on an
      // even-sized set — the standard definition of median, and one Postgres
      // computes for us rather than requiring a fetch-all-and-sort in JS.
      medianMs: sql<string | number | null>`percentile_cont(0.5) within group (order by ${proposals.decisionLatencyMs})`,
    })
    .from(proposals)
    .where(and(eq(proposals.decidedBy, 'user'), inArray(proposals.status, ['executed', 'rejected'])));

  const executed = Number(row?.executed ?? 0);
  const rejected = Number(row?.rejected ?? 0);
  const decisionCount = executed + rejected;

  if (decisionCount < MIN_HEALTH_DECISIONS) {
    return { decisionCount, approvalRate: null, medianDecisionMs: null };
  }

  return {
    decisionCount,
    approvalRate: executed / decisionCount,
    medianDecisionMs: row?.medianMs == null ? null : Math.round(Number(row.medianMs)),
  };
}

export async function listReviewQueue(params: ReviewQueueParams): Promise<ReviewQueueResult> {
  await maybeRepairProposals();
  const counts = await computeReviewQueueCounts();

  if (params.status === 'blocked') {
    // See computeReviewQueueCounts's comment: the Blocked segment has
    // nothing to project from until agent_runs exists. The query-param/
    // segment shape stays real (this branch exists and is reachable) —
    // it just has no rows to return today.
    return { proposals: [], counts, nextCursor: null };
  }

  const limit = Math.min(params.limit ?? DEFAULT_REVIEW_QUEUE_LIMIT, MAX_REVIEW_QUEUE_LIMIT);

  const conditions =
    params.status === 'proposed'
      ? [eq(proposals.status, 'proposed')]
      : [
          // 'recent': resolved in the last 24h. Explicitly the terminal
          // statuses, not "resolvedAt set" — 'executing' also stamps
          // resolvedAt (it doubles as the claim timestamp), and a row
          // mid-claim is not "recent", it's still pending.
          inArray(proposals.status, TERMINAL_PROPOSAL_STATUSES),
          gte(proposals.resolvedAt, new Date(Date.now() - RECENT_WINDOW_MS)),
        ];

  if (params.agentId) conditions.push(eq(proposals.agentId, params.agentId));
  if (params.projectId) conditions.push(eq(proposals.projectId, params.projectId));
  if (params.kind) conditions.push(eq(proposals.kind, params.kind));

  if (params.cursor) {
    const c = decodeCursor(params.cursor);
    // Keyset on (created_at, id) DESC: strictly older createdAt, OR the
    // same createdAt with a strictly smaller id as the tiebreaker.
    // or()'s general signature returns `SQL | undefined` (undefined only
    // when called with zero conditions) — always 2 non-undefined conditions
    // here, so this is genuinely never undefined at runtime.
    conditions.push(
      or(lt(proposals.createdAt, c.createdAt), and(eq(proposals.createdAt, c.createdAt), lt(proposals.id, c.id)))!,
    );
  }

  const rows = await db
    .select()
    .from(proposals)
    .where(and(...conditions))
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const { displayName } = await membersService.getCurrentUser();
  return {
    proposals: page.map((row) => toView(row, displayName)),
    counts,
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

export interface BulkProposalResult {
  id: string;
  status: ProposalStatus | 'not_found';
  statusReason: string | null;
}

// Sequential, not Promise.all — deliberately not one transaction
// (architecture §4.4): a stale/already-resolved id must resolve on its own
// and the rest of the batch must still run. Each id runs the EXISTING
// single-row approveProposal, unmodified — this never reimplements the
// claim/staleness/execute logic above.
export async function bulkApproveProposals(ids: string[]): Promise<BulkProposalResult[]> {
  const results: BulkProposalResult[] = [];
  for (const id of ids) {
    try {
      const view = await approveProposal(id);
      results.push({ id, status: view.status, statusReason: view.statusReason });
    } catch (error) {
      if (error instanceof NotFoundError) {
        results.push({ id, status: 'not_found', statusReason: 'proposal not found' });
        continue;
      }
      throw error;
    }
  }
  return results;
}

export async function bulkRejectProposals(ids: string[]): Promise<BulkProposalResult[]> {
  const results: BulkProposalResult[] = [];
  for (const id of ids) {
    try {
      const view = await rejectProposal(id);
      results.push({ id, status: view.status, statusReason: view.statusReason });
    } catch (error) {
      if (error instanceof NotFoundError) {
        results.push({ id, status: 'not_found', statusReason: 'proposal not found' });
        continue;
      }
      throw error;
    }
  }
  return results;
}

// Ticket-detail's inline section (architecture §4.4).
export async function listProposalsForTicket(ticketId: string, status?: ProposalStatus): Promise<ProposalView[]> {
  const conditions = [eq(proposals.ticketId, ticketId)];
  if (status) conditions.push(eq(proposals.status, status));
  const rows = await db
    .select()
    .from(proposals)
    .where(and(...conditions))
    .orderBy(desc(proposals.createdAt));
  const { displayName } = await membersService.getCurrentUser();
  return rows.map((row) => toView(row, displayName));
}

// Requests page's inline section (W4.4, architecture §4.4) — same shape as
// listProposalsForTicket above, scoped by source_request_id instead of
// ticket_id. Set when a proposal originated from triaging an incoming
// request (schema note on proposals.sourceRequestId); nothing populates it
// yet, so this returns [] until a later unit (a triage agent, or Copilot
// proposing against a request) sets it.
export async function listProposalsForRequest(requestId: string, status?: ProposalStatus): Promise<ProposalView[]> {
  const conditions = [eq(proposals.sourceRequestId, requestId)];
  if (status) conditions.push(eq(proposals.status, status));
  const rows = await db
    .select()
    .from(proposals)
    .where(and(...conditions))
    .orderBy(desc(proposals.createdAt));
  const { displayName } = await membersService.getCurrentUser();
  return rows.map((row) => toView(row, displayName));
}
