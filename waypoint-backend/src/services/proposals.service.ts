import { eq, and, or, lt, gte, desc, count, countDistinct, inArray, asc, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { proposals, copilotConversations, copilotMessages, tickets } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { NotFoundError, ValidationError } from '../middleware/errors.js';
import { buildCopilotCommentHtml, COPILOT_DISCLOSURE } from '../lib/commentHtml.js';
import { buildCopilotJiraCommentAdf } from '../lib/jira/adf.js';
import type { JiraCredential } from '../lib/jira/client.js';
import { getJiraProvider, isExternalRef, type JiraProvider } from '../providers/jira.js';
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
// execute (the process died between claim and finalize), not one in flight.
// repairProposals parks such rows as 'stale' — never back to 'proposed',
// where one more Approve click would run the write a second time, since
// there is no way to tell whether the crash happened before or after the
// underlying write ran.
//
// A native execute really is a single-digit-millisecond service call, but a
// Jira execute is not: checkJiraStaleness alone can issue two sequential
// requests (getByRef, listTransitions, for a state_change proposal only)
// before executeJiraProposal issues a third (applyTransition or
// postComment), and each one is bounded by REQUEST_TIMEOUT_MS
// (lib/jira/client.ts, 20s) rather than being instant. A
// merely-slow-but-successful Jira approve can cross a 60s threshold while
// the write is still in flight, which does not corrupt anything — a 'stale'
// row can't be re-claimed, because the claim UPDATE itself is guarded on
// `eq(proposals.status, 'proposed')`, and finalize's own status='executing'
// guard separately stops a late-arriving execute from stomping the row
// repairProposals already parked — but it does mislabel a real write as
// interrupted. Set above the worst realistic case of three sequential
// 20s-bounded Jira requests, with headroom.
const EXECUTING_STUCK_MS = 120 * 1000;

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
// Terminal statuses only — the full set RECENT_SEGMENT_STATUSES below
// narrows from (its only consumer). 'executing' is deliberately excluded:
// resolvedAt doubles as its claim timestamp (see EXECUTING_STUCK_MS above),
// so a row mid-claim must never be counted as "resolved".
const TERMINAL_PROPOSAL_STATUSES: ProposalStatus[] = [
  'executed',
  'rejected',
  'stale',
  'expired',
  'superseded',
  'reverted',
];

// ROAD-14: 'recent' excludes 'stale'. A stale row now has its own permanent
// home in the 'blocked' segment (not time-windowed — see
// computeReviewQueueCounts/listReviewQueue below), so counting/listing it
// under 'recent' too would double it up across two tabs and mislabel it
// "handled overnight, no action needed" when dismissing it is exactly the
// action still outstanding. Every other terminal status here really is
// done (approved/rejected/expired/superseded/reverted) with nothing left
// to act on, so those stay in 'recent' unchanged.
const RECENT_SEGMENT_STATUSES: ProposalStatus[] = TERMINAL_PROPOSAL_STATUSES.filter(
  (status) => status !== 'stale',
);

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
  // Null for a proposal targeting an external ("tref-") issue — a Jira issue
  // is not scoped to any Waypoint project. See the column's own comment.
  projectId: string | null;
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
    //
    // The subquery yields NULL for a Jira ("tref-") ticketId, which matches
    // no row in `tickets` — and that is the intended answer, not a miss: a
    // Jira issue belongs to a Jira project, which has no `projects` row to
    // point at. The column is nullable precisely for this carve-out, so the
    // insert succeeds and the proposal lands with a null project. Such a
    // proposal is correctly outside every project-filtered queue read and
    // shows up under "All projects".
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
      statusReason: boundStatusReason('This proposal expired before it was reviewed'),
      resolvedAt: now,
      decidedBy: 'system',
    })
    .where(and(eq(proposals.status, 'proposed'), lt(proposals.expiresAt, now)));
  await db
    .update(proposals)
    .set({
      status: 'stale',
      // Both literals here are self-authored and safe as written today — the
      // point of routing them through boundStatusReason anyway is that
      // finalize() being "the only seam" stays a TRUE claim rather than one
      // that happens to hold only because nobody has changed these two
      // literals to include upstream text yet (a real gap a review round
      // caught: this file previously said finalize() was the only seam while
      // these two writes bypassed it entirely).
      statusReason: boundStatusReason(
        'Approval was interrupted — check the ticket before asking Copilot to propose this again.',
      ),
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

/**
 * Which system a proposal's ticket ACTUALLY lives in, from the id itself.
 *
 * The one authority on this question. A "tref-" id can only have come from a
 * ticket_refs row and every native ticket id is minted "wi-" (lib/ids.ts), so
 * the id alone settles it with no lookup — and, crucially, with nothing
 * stored alongside it able to disagree. `snapshot.provider` exists for the
 * card to render; this is what routes a write.
 *
 * Null only for a proposal with no ticket at all, i.e. create_ticket.
 */
function providerOf(ticketId: string | null): 'native' | 'jira' | null {
  if (!ticketId) return null;
  return isExternalRef(ticketId) ? 'jira' : 'native';
}

// Fresh reads against live data, run AFTER the claim so a passing check is
// as close to execution as this design gets (ms-scale TOCTOU accepted — see
// the architecture notes; refactoring the underlying service signatures for
// perfect atomicity was explicitly ruled out).
async function checkStaleness(
  row: ProposalRow,
  jira: JiraProvider | null,
): Promise<StaleResult | null> {
  const kind = row.kind as ProposalKind;
  const snapshot = row.snapshot as Record<string, unknown>;

  // Dispatched on the id, before the native lookup — passing a "tref-" id to
  // ticketsService.getTicket would find nothing and report "this ticket is no
  // longer available" about an issue that is perfectly fine.
  if (providerOf(row.ticketId) === 'jira') {
    return checkJiraStaleness(row, jira);
  }

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

/**
 * Staleness for a proposal targeting a Jira issue.
 *
 * Same job as the native checks — "does what the card shows still match
 * reality" — but it has one more thing to re-read, and that one is easy to
 * miss because it has no native counterpart.
 *
 * A native target state either exists or does not, and its existence does not
 * depend on the ticket. A Jira TRANSITION is different: which transitions an
 * issue can make is a function of the status it is in right now. So a
 * proposal minted when the issue was "In Progress" can carry a transition id
 * that was perfectly legal then and is meaningless now, without the issue
 * having been deleted and without anything else looking wrong. Checking only
 * "does the issue still exist" would sail past that, and the reviewer would
 * find out from Jira's 400 after clicking Approve.
 *
 * A missing credential is stale, not a crash: Jira being disconnected between
 * propose and approve is a thing a person does, and the proposal genuinely
 * cannot be applied any more. It is the same shape as every other staleness —
 * the card explains itself and nothing executes.
 */
async function checkJiraStaleness(
  row: ProposalRow,
  jira: JiraProvider | null,
): Promise<StaleResult | null> {
  if (!jira) {
    return { stale: true, reason: 'Jira is no longer connected, so this change cannot be applied' };
  }
  const ticketId = row.ticketId as string;
  const snapshot = row.snapshot as Record<string, unknown>;

  const ticket = await jira.getByRef(ticketId);
  if (!ticket) return { stale: true, reason: 'This Jira issue is no longer available' };

  if ((row.kind as ProposalKind) === 'state_change') {
    // The issue's own status, against the one captured at propose time — the
    // exact native check, on the value that means the same thing here.
    if (ticket.stateId !== snapshot.fromStateId) {
      return { stale: true, reason: 'This issue changed since Copilot proposed this — ask again' };
    }
    const { stateId: transitionId } = row.payload as { stateId: string };
    const transitions = await jira.listTransitions(ticketId);
    if (!transitions?.some((t) => t.id === transitionId)) {
      return {
        stale: true,
        reason: 'That move is no longer available on this Jira issue — ask again',
      };
    }
  }

  return null;
}

// statusReason is stored (an unbounded `text` column), rendered directly on
// the review card, AND — for a 'stale' outcome only — read by
// useCopilotProposals.ts's own outcomeSentence on the frontend to describe
// what happened... except that function deliberately does NOT interpolate
// it into the model-facing prompt (found in review: an earlier version of
// its own header comment claimed no upstream text ever reached the model
// while this exact value could). Most of the time statusReason is a string
// this file wrote itself, but ONE real path hands it Jira's own
// error/refusal text verbatim: the applyTransition/postComment failure
// messages in providers/jira.ts, deliberately "carried through" so the
// reviewer sees Jira's own explanation. checkJiraStaleness's own messages
// (just above executeJiraProposal) are NOT in this category, despite an
// earlier version of this comment claiming otherwise — every one of them is
// a file-authored literal with no Jira interpolation; only the two
// TerminalExecutionFailure paths through providers/jira.ts carry text this
// process does not control the length or shape of. Bounded at this one
// seam, the only place every statusReason write passes through (including
// repairProposals's own two literal writes below — routed through here too
// so this claim stays true by construction rather than by nobody having
// changed those literals to include upstream text yet): a cap so a
// pathological response can't bloat a row or the render, and a
// control-character-and-formatting strip (C0, C1, DEL, and the Unicode
// bidi/format controls a Trojan-Source-style attack would use to visually
// reorder the approval banner a human reads before deciding) so nothing
// upstream can smuggle formatting control sequences into a UI string.
const STATUS_REASON_MAX_LENGTH = 500;

function boundStatusReason(reason: string | null | undefined): string | null | undefined {
  if (reason == null) return reason;
  // Written as explicit \u escapes rather than a literal character class,
  // the same rule providers/jira.ts's jqlQuoted applies and for the same
  // reason: control characters are invisible in source, so a class typed
  // literally is unreviewable and one keystroke away from silently becoming
  // a printable range instead of a control-character one.
  // C0 + DEL, C1, and the Unicode bidi/format controls (zero-width
  // marks, embedding/override, isolates) a Trojan-Source-style attack
  // would use to visually reorder this text in the banner a human reads
  // before approving a write to their own Jira.
  // eslint-disable-next-line no-control-regex
  const stripped = reason
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .trim();
  // A non-null reason that's entirely whitespace or control characters
  // strips down to '' — which is falsy-adjacent but not null, so a
  // caller's `statusReason ?? 'fallback text'` (CopilotProposalCard.tsx
  // does exactly this) would never fire, and the card would render an
  // empty banner instead of the fallback it was written to show.
  // Normalized to null so every existing null-coalescing caller already
  // does the right thing.
  if (stripped.length === 0) return null;
  return stripped.length > STATUS_REASON_MAX_LENGTH
    ? `${stripped.slice(0, STATUS_REASON_MAX_LENGTH - 1)}…`
    : stripped;
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
    .set({ ...patch, statusReason: boundStatusReason(patch.statusReason), resolvedAt: new Date() })
    .where(and(eq(proposals.id, id), eq(proposals.status, 'executing')))
    .returning();
  if (row) return row;
  const [current] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id));
  return current;
}

// Internal signal for an executeProposal failure whose correct resolution
// is a TERMINAL status, not approveProposal's generic revert-to-'proposed'
// (final review findings M1/M5). Reverting to 'proposed' makes the card
// approvable again, which is actively harmful for both cases this is thrown
// for:
//  - create_ticket: the first write (ticket creation) already committed
//    before the second write (setting dueDate) failed — retrying would run
//    createTicket a SECOND time, a duplicate ticket.
//  - add_label: executeProposal has no real implementation for this kind
//    (see the ProposalKind comment — no propose_add_label tool exists yet
//    to produce one, but it IS a live enum value) — retrying would just
//    throw again on every Approve click, forever.
// approveProposal's catch special-cases this instead of its generic revert.
class TerminalExecutionFailure extends Error {
  constructor(
    public readonly status: 'stale' | 'rejected',
    public readonly reason: string,
    public readonly resultInfo: unknown = null,
  ) {
    super(reason);
    this.name = 'TerminalExecutionFailure';
  }
}

async function executeProposal(
  row: ProposalRow,
  displayName: string,
  jira: JiraProvider | null,
): Promise<unknown> {
  const kind = row.kind as ProposalKind;

  // THE ROUTING ASSERTION. Read this before changing anything below it.
  //
  // A proposal row carries two accounts of where its write should land: the
  // ticket id, and `snapshot.provider`. Only the first is authoritative — the
  // id is minted with a provider-distinguishing prefix and nothing can edit
  // it out from under itself, while the snapshot is display data written once
  // at propose time and never refreshed.
  //
  // So the provider is re-derived from the id here, live, and compared. If
  // they disagree, something is wrong in a way this function cannot make
  // safe: either a row was hand-edited, or a future propose handler wrote a
  // snapshot that does not describe its own target — and the failure mode of
  // guessing is writing to the wrong system. Nothing downstream reads
  // `snapshot.provider` for anything but rendering, and this is what turns
  // that from a convention someone could quietly violate into a fact the code
  // enforces.
  //
  // A PLAIN Error, deliberately, not TerminalExecutionFailure: this is an
  // invariant violation, not a user-facing outcome. It takes approveProposal's
  // generic catch, which releases the claim and leaves the card pending — the
  // right shape for something a fix could make work, and the wrong shape for
  // something to be silently finalized away.
  const actualProvider = providerOf(row.ticketId) ?? 'native';
  const claimedProvider = (row.snapshot as Record<string, unknown>).provider;
  // Absent is not a disagreement: every proposal minted before external
  // writes existed has no `provider` in its snapshot, and is native.
  if (claimedProvider !== undefined && claimedProvider !== actualProvider) {
    throw new Error(
      `proposal ${row.id}: snapshot claims provider "${String(claimedProvider)}" but ticket id "${String(row.ticketId)}" is ${actualProvider} — refusing to execute`,
    );
  }

  if (actualProvider === 'jira') return executeJiraProposal(row, displayName, jira);

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
        try {
          await ticketsService.updateTicket(created.id, { dueDate: payload.dueDate });
        } catch {
          // createTicket already committed its own transaction — this
          // execute is now PARTIAL, not failed. approveProposal's generic
          // catch must not revert this row to 'proposed' (see
          // TerminalExecutionFailure above): re-approving would call
          // createTicket a second time and create a duplicate ticket. Park
          // it as stale instead, carrying the created ticket's id/identifier
          // so the card can still link to it.
          throw new TerminalExecutionFailure(
            'stale',
            `${created.identifier} was created, but setting its due date failed — check the ticket directly.`,
            { ticketId: created.id, identifier: created.identifier },
          );
        }
      }
      return { ticketId: created.id, identifier: created.identifier };
    }
    case 'add_label': {
      // No propose_add_label MCP tool exists yet, so this kind is
      // unreachable in practice today (see the ProposalKind comment) — but
      // it IS a live value in the schema/enum, so execute must still handle
      // it defensively rather than falling through to the generic
      // `default: throw`, which would trip approveProposal's revert-to-
      // 'proposed' catch and infinite-loop Approve forever. Fail this one
      // permanently and cleanly instead.
      throw new TerminalExecutionFailure(
        'rejected',
        'Adding labels via Copilot is not supported yet — this proposal cannot be approved.',
      );
    }
    default:
      throw new Error(`unknown proposal kind: ${String(kind)}`);
  }
}

/**
 * The write half, for a ticket that lives in Jira.
 *
 * Mirrors the native switch's shape rather than extending it, because the two
 * do genuinely different things with the same words: a native state_change is
 * an UPDATE on a column, a Jira one applies a named transition whose legality
 * Jira itself decides.
 *
 * Every refusal here is a TerminalExecutionFailure('stale'), never a plain
 * throw, and that is the important part. A plain throw takes approveProposal's
 * generic catch, which reverts the row to 'proposed' so the user can try
 * again — right for a transient failure, and actively wrong for these: the
 * issue is gone, or the transition is no longer legal, or Jira refused this
 * account. None of those improves on the next click, and offering the click
 * anyway is offering a button that can only fail. The genuinely transient
 * cases never reach here at all — the provider throws
 * ProviderUnavailableError for those, which IS the retryable shape.
 *
 * The self-disclosure uses the WAYPOINT user's display name, the same one the
 * native path uses and the same one the card previewed (see ProposalView's
 * disclosureText, whose whole contract is that the preview matches what gets
 * written). Which Atlassian account the comment posts AS is a separate fact,
 * and the card states it separately, in the external-write banner.
 */
async function executeJiraProposal(
  row: ProposalRow,
  displayName: string,
  jira: JiraProvider | null,
): Promise<unknown> {
  // checkStaleness already resolves this to a stale card, so reaching here
  // with no credential means it was revoked in the milliseconds between —
  // same outcome, stated the same way, rather than an unhandled null.
  if (!jira) {
    throw new TerminalExecutionFailure(
      'stale',
      'Jira is no longer connected, so this change cannot be applied',
    );
  }
  const ticketId = row.ticketId as string;

  switch (row.kind as ProposalKind) {
    case 'comment': {
      const { body } = row.payload as { body: string };
      const posted = await jira.postComment(ticketId, buildCopilotJiraCommentAdf(displayName, body));
      if (posted === null) {
        throw new TerminalExecutionFailure(
          'stale',
          'That Jira issue no longer exists, so the comment was not posted',
        );
      }
      // A forbidden/jira_error result is terminal for the same reason a
      // refused transition is (see applyTransition below): retrying an
      // identical comment never fixes a permission or content rejection, so
      // this must finalize the card rather than leave an Approve button that
      // can only ever fail.
      if (!posted.ok) throw new TerminalExecutionFailure('stale', posted.message);
      return { commentId: posted.commentId };
    }
    case 'state_change': {
      // A Jira state_change payload's `stateId` is a TRANSITION id — see
      // proposalTools.ts's proposeJiraTransition for why the two are not
      // interchangeable.
      const { stateId: transitionId } = row.payload as { stateId: string };
      const result = await jira.applyTransition(ticketId, transitionId);
      // Jira's own sentence, carried through verbatim: it knows why a
      // transition was refused and this process does not.
      if (!result.ok) throw new TerminalExecutionFailure('stale', result.message);
      return null;
    }
    default:
      // assignee_change, priority_change, create_ticket and add_label. The
      // propose tools refuse to mint these against a Jira id at all, so this
      // is unreachable by any path that exists — but "unreachable" is a claim
      // about today's callers, and falling through to the native switch would
      // run a Waypoint write against a ticket id that is not a Waypoint
      // ticket. Fail permanently and legibly instead.
      throw new TerminalExecutionFailure(
        'rejected',
        'This kind of change is not supported for Jira issues.',
      );
  }
}

/**
 * `jiraCredential` is borrowed for this request, exactly as the MCP endpoint
 * borrows one — it arrives on the approve request's own header, having come
 * from the desktop app's main process, which holds the only persisted copy
 * (see lib/jira/credentialHeader.ts). It is threaded rather than looked up
 * because there is nowhere in this process to look it up from, which is the
 * property that makes it safe to hold at all.
 *
 * Null is a normal state, not an error: most proposals are native and never
 * touch it, and a Jira proposal approved without one resolves as stale rather
 * than crashing (see checkJiraStaleness).
 */
export async function approveProposal(
  id: string,
  jiraCredential: JiraCredential | null = null,
): Promise<ProposalView> {
  const jira = getJiraProvider(jiraCredential);
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

  // The staleness check can now make a NETWORK call (a Jira read), which the
  // native-only version never could — so it can now fail transiently, and a
  // throw from here used to leave the row parked in 'executing' until the
  // stuck-claim repair swept it a minute later. Release the claim so the card
  // stays pending and Approve stays clickable, then let errorHandler shape
  // the response: a Jira outage should cost the user a retry, not a proposal.
  let staleness: StaleResult | null;
  try {
    staleness = await checkStaleness(claimed, jira);
  } catch (error) {
    await db
      .update(proposals)
      .set({ status: 'proposed', resolvedAt: null })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'executing')));
    throw error;
  }
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
    resultInfo = await executeProposal(claimed, displayName, jira);
  } catch (error) {
    // TerminalExecutionFailure (final review findings M1/M5): the generic
    // revert below must NOT run for this — reverting to 'proposed' would
    // make the card approvable again for an outcome that's either already
    // partially committed (a duplicate write on retry) or can never
    // succeed (an infinite retry loop). Finalize straight to the terminal
    // status the failure carries instead. Nobody decided this — the
    // failure did — so decidedBy='system', same as every other
    // system-driven resolution in this file.
    if (error instanceof TerminalExecutionFailure) {
      const finalized = await finalize(id, {
        status: error.status,
        statusReason: error.reason,
        resultInfo: error.resultInfo,
        decidedBy: 'system',
      });
      return toView(finalized, displayName);
    }
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
  // Clamped to the int4 max: decisionLatencyMs is a Postgres `integer`
  // column, which caps at 2147483647 (~24.8 days in ms). A 'stale' proposal
  // has no TTL, so a row that sits stale long enough would otherwise
  // overflow int4 here and Postgres would throw 22003 on every reject
  // attempt, forever (the row's createdAt never changes, so the raw value
  // only grows). LEAST(...) keeps the write in range without a schema change.
  const [updated] = await db
    .update(proposals)
    .set({
      status: 'rejected',
      resolvedAt: new Date(),
      decidedBy: 'user',
      decisionLatencyMs: sql`least((extract(epoch from (now() - ${proposals.createdAt})) * 1000)::bigint, 2147483647)::int`,
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
  // decisionLatencyMs per-row from that row's own createdAt. Clamped to the
  // int4 max for the same reason as rejectProposal: this is a single UPDATE
  // across every matched row, so one old stale row overflowing int4 would
  // fail the whole batch instead of just that row.
  const rows = await db
    .update(proposals)
    .set({
      status: 'rejected',
      resolvedAt: new Date(),
      decidedBy: 'user',
      decisionLatencyMs: sql`least((extract(epoch from (now() - ${proposals.createdAt})) * 1000)::bigint, 2147483647)::int`,
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
  // Three independent counts, run concurrently rather than one after
  // another: this runs on every listReviewQueue call (including every
  // "Load more" page) and every refreshCounts poll after an approve/reject,
  // so it's one of this app's hottest reads, and none of the three queries
  // depends on another's result.
  const [proposedRow, blockedRow, recentRow] = await Promise.all([
    db.select({ n: count() }).from(proposals).where(eq(proposals.status, 'proposed')),
    // ROAD-14: "Blocked" was designed to project a future agent_runs.status
    // ='blocked' into this same card shape (architecture §4.4) — that table
    // doesn't exist yet (agent-run infrastructure is deferred per the
    // founder's Copilot-freeze scope decision). In the meantime, every
    // 'stale' proposal (a Jira transition refusal, a ticket moved out from
    // under a proposal, a disconnected Jira, an interrupted approve — see
    // checkStaleness/checkJiraStaleness above) IS a real, present-day
    // blocked item: something that needs a human's attention and has no
    // other aggregate home. Not time-windowed like 'recent' — a stale row
    // stays "blocked" until someone dismisses it, however long that takes.
    db.select({ n: count() }).from(proposals).where(eq(proposals.status, 'stale')),
    db
      .select({ n: count() })
      .from(proposals)
      .where(and(inArray(proposals.status, RECENT_SEGMENT_STATUSES), gte(proposals.resolvedAt, cutoff))),
  ]);
  return {
    proposed: proposedRow[0].n,
    blocked: blockedRow[0].n,
    recent: recentRow[0].n,
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

  const limit = Math.min(params.limit ?? DEFAULT_REVIEW_QUEUE_LIMIT, MAX_REVIEW_QUEUE_LIMIT);

  const conditions =
    params.status === 'proposed'
      ? [eq(proposals.status, 'proposed')]
      : params.status === 'blocked'
        ? // ROAD-14: see computeReviewQueueCounts's comment — 'stale' is the
          // real, present-day Blocked segment (not time-windowed, unlike
          // 'recent'), pending the future agent_runs.status='blocked' work.
          [eq(proposals.status, 'stale')]
        : [
            // 'recent': resolved in the last 24h. Explicitly the terminal
            // statuses (minus 'stale', which now lives in 'blocked'
            // instead — see RECENT_SEGMENT_STATUSES), not "resolvedAt set"
            // — 'executing' also stamps resolvedAt (it doubles as the
            // claim timestamp), and a row mid-claim is not "recent", it's
            // still pending.
            inArray(proposals.status, RECENT_SEGMENT_STATUSES),
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

// Best-effort fallback for the bulk loops below: when approve/reject throws
// something other than NotFoundError, report the row's ACTUAL current
// status rather than inventing a synthetic one. approveProposal's own catch
// already reverts a claimed-then-failed row back to 'proposed' (except for
// the TerminalExecutionFailure cases above, which finalize it themselves),
// so this read reflects reality, not a guess — and it stays within the
// existing ProposalStatus union the caller (and the frontend's identical
// type) already knows how to render.
async function currentProposalStatusOrNotFound(id: string): Promise<ProposalStatus | 'not_found'> {
  const [existing] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  return existing ? (existing.status as ProposalStatus) : 'not_found';
}

// Sequential, not Promise.all — deliberately not one transaction
// (architecture §4.4): a stale/already-resolved id must resolve on its own
// and the rest of the batch must still run. Each id runs the EXISTING
// single-row approveProposal, unmodified — this never reimplements the
// claim/staleness/execute logic above.
export async function bulkApproveProposals(
  ids: string[],
  // The same borrowed credential a single approve gets, handed to each row in
  // turn. Threading it here rather than resolving one provider for the batch
  // keeps this what its comment below says it is: single-row approveProposal,
  // unmodified, in a loop.
  jiraCredential: JiraCredential | null = null,
): Promise<BulkProposalResult[]> {
  const results: BulkProposalResult[] = [];
  for (const id of ids) {
    try {
      const view = await approveProposal(id, jiraCredential);
      results.push({ id, status: view.status, statusReason: view.statusReason });
    } catch (error) {
      if (error instanceof NotFoundError) {
        results.push({ id, status: 'not_found', statusReason: 'proposal not found' });
        continue;
      }
      // Final review finding M3: approveProposal can also throw
      // ConflictError (e.g. createTicket's validateAssigneeIds, when a
      // proposed assignee was since deleted) and, in principle, other
      // unexpected error types. Throwing out of this loop discarded the
      // WHOLE request's results, including already-successful approvals
      // earlier in the batch, and surfaced no record of which id failed or
      // why. Record this id's failure and keep processing the rest.
      const reason = error instanceof Error ? error.message : 'approve failed';
      results.push({ id, status: await currentProposalStatusOrNotFound(id), statusReason: reason });
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
      // Same reasoning as bulkApproveProposals above: never discard the
      // rest of the batch (or already-successful results ahead of it) over
      // one id's unexpected failure.
      const reason = error instanceof Error ? error.message : 'reject failed';
      results.push({ id, status: await currentProposalStatusOrNotFound(id), statusReason: reason });
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
