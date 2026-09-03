import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, pgEnum, bigint, jsonb, index, integer } from 'drizzle-orm/pg-core';
import { copilotConversations } from './copilot.js';
import { requests } from './requests.js';

// Renamed from copilot_proposals/copilot_proposal_kind/copilot_proposal_status
// (P3 W3.1 — see docs/design/waypoint-revamp-architecture.md §4.2). The
// table moved out of copilot.ts because it is no longer copilot-only: a
// proposal can now originate from an autonomous agent run as well as a
// Copilot conversation turn. NONE of the state-machine logic in
// proposals.service.ts changed for this move — only scope widened.
export const proposalOriginEnum = pgEnum('proposal_origin', [
  'copilot', // a Copilot conversation turn
  'agent_run', // an autonomous agent run
]);

export const proposalDecidedByEnum = pgEnum('proposal_decided_by', [
  'user', // a person clicked Approve or Reject
  'trust_grant', // an earned-trust grant auto-applied it
  'system', // expired / stale / superseded
]);

// UNCHANGED values from copilot_proposal_kind, plus one addition.
export const proposalKindEnum = pgEnum('proposal_kind', [
  'comment',
  'state_change',
  'assignee_change',
  'priority_change',
  'create_ticket',
  'add_label', // NEW — the mockup's most common trust candidate
]);

// UNCHANGED values from copilot_proposal_status, plus one terminal state for
// the future Undo path (architecture §4.5 — not built in this pass).
export const proposalStatusEnum = pgEnum('proposal_status', [
  'proposed',
  'executing',
  'executed',
  'rejected',
  'stale',
  'expired',
  'superseded',
  'reverted', // NEW — an executed proposal the user undid
]);

// One row per propose_* MCP tool call, or (later) per autonomous agent run
// action. The model/agent never executes anything: it writes one of these
// rows, the renderer shows it as an approval card, and only a user's
// explicit approve (or, later, an earned-trust grant) triggers the real
// service-layer write. See proposals.service.ts for the full state machine
// this table backs — that logic is unchanged by this schema widening.
export const proposals = pgTable(
  'proposals',
  {
    id: text('id').primaryKey(),

    // --- scope: this is the whole point of the widening ------------------
    origin: proposalOriginEnum('origin').notNull(),
    // NOW NULLABLE (was required). Non-null only for origin='copilot'.
    conversationId: text('conversation_id').references(() => copilotConversations.id, { onDelete: 'cascade' }),
    // NOW NULLABLE (was required). Non-null only for origin='copilot'
    // (transcript anchor) — max(copilot_messages.seq) at propose time.
    anchorSeq: bigint('anchor_seq', { mode: 'number' }),
    // Non-null only for origin='agent_run'. Plain column, no FK: agent_runs
    // doesn't exist as a table yet — agent-run infrastructure is deferred
    // per the founder's Copilot-freeze scope decision (this P3 pass does not
    // build agent runtime). A later commit that introduces agent_runs
    // should add `.references(() => agentRuns.id, { onDelete: 'set null' })`
    // here.
    agentRunId: text('agent_run_id'),
    // Denormalised from the run/agent so the queue can filter without a
    // join. No FK cascade: an agent deleted mid-review must leave its
    // proposals readable, the same reasoning ticketId already uses.
    agentId: text('agent_id'),
    // Denormalised. NOT NULL. Every proposal belongs to exactly one
    // project — create_ticket carries it in the payload, everything else
    // via the ticket. This is what makes the Review queue's project filter
    // one index scan. Deliberately not an FK, matching ticketId/agentId's
    // reasoning above.
    projectId: text('project_id').notNull(),
    // Set when the proposal originated from triaging an incoming request.
    sourceRequestId: text('source_request_id').references(() => requests.id, { onDelete: 'set null' }),

    // --- unchanged from copilot_proposals ---------------------------------
    kind: proposalKindEnum('kind').notNull(),
    ticketId: text('ticket_id'), // deliberately not an FK, as before
    payload: jsonb('payload').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    status: proposalStatusEnum('status').notNull().default('proposed'),
    statusReason: text('status_reason'),
    resultInfo: jsonb('result_info'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    modelNotifiedAt: timestamp('model_notified_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // --- decision provenance, new (populated starting with the future
    // earned-trust P4 unit — proposals.service.ts's approve/reject logic is
    // deliberately NOT changed to populate these in this pass) -----------
    decidedBy: proposalDecidedByEnum('decided_by'),
    // The grant that auto-applied this, if any. Plain column, no FK: the
    // agent_trust_grants table doesn't exist yet (§4.5 is a later P4 unit).
    // A later commit that introduces agent_trust_grants should add
    // `.references(() => agentTrustGrants.id, { onDelete: 'set null' })`.
    trustGrantId: text('trust_grant_id'),
    // Wall-clock milliseconds between the row becoming visible and the
    // decision. Stored, not derived — the review-health strip needs it and
    // it cannot be reconstructed after the fact. NULL for system
    // resolutions (and, for now, for every resolution — see above).
    decisionLatencyMs: integer('decision_latency_ms'),
  },
  (t) => [
    // The queue's hot query: pending, newest first.
    index('proposals_status_created_at_idx').on(t.status, t.createdAt),
    // Queue filters.
    index('proposals_project_status_idx').on(t.projectId, t.status),
    index('proposals_agent_status_idx').on(t.agentId, t.status),
    // Ticket detail's inline section.
    index('proposals_ticket_status_idx').on(t.ticketId, t.status),
    // The Copilot panel's transcript query, unchanged in shape.
    index('proposals_conversation_created_at_idx').on(t.conversationId, t.createdAt),
    // Trust computation: last N decisions for (agent, kind).
    index('proposals_agent_kind_resolved_idx').on(t.agentId, t.kind, t.resolvedAt),
    // Repair pass partial indexes (W3.3) — the aggregate queue has no
    // conversation id to scope a repair scan by, so the pass runs
    // workspace-wide on a timer instead of per-call; these keep that scan
    // cheap regardless of table size.
    index('proposals_pending_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'proposed'`),
    index('proposals_stuck_claim_idx')
      .on(t.resolvedAt)
      .where(sql`${t.status} = 'executing'`),
  ],
);
