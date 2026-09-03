import { pgTable, text, timestamp, pgEnum, bigserial, bigint, jsonb, index } from 'drizzle-orm/pg-core';
import { members } from './workspace.js';

export const copilotMessageRoleEnum = pgEnum('copilot_message_role', ['user', 'assistant']);

// Multiple conversations per member (issue #11) — memberId is deliberately
// NOT unique. Listing (copilot.service.ts's listConversations) queries
// WHERE member_id = ? ORDER BY updated_at DESC, served by the composite
// index below in one scan.
export const copilotConversations = pgTable(
  'copilot_conversations',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    // Auto-derived from the conversation's first user message (see
    // postUserMessage) until the user renames it. The default here is what a
    // freshly created, still-empty conversation shows in the list.
    title: text('title').notNull().default('New session'),
    // The Claude Code CLI's own session id (issue #7) — passed back to `claude
    // -p ... --resume <id>` so a conversation's later turns continue the same
    // Claude Code session instead of starting fresh each message. Null until
    // the first assistant reply ever completes.
    claudeSessionId: text('claude_session_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('copilot_conversations_member_id_updated_at_idx').on(table.memberId, table.updatedAt)],
);

export const copilotMessages = pgTable(
  'copilot_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => copilotConversations.id, { onDelete: 'cascade' }),
    role: copilotMessageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    // Authoritative ordering, not createdAt: createdAt defaults to now(),
    // which Postgres resolves to transaction_timestamp() — constant for
    // every statement in the same transaction. postMessage() inserts the
    // user message and the assistant reply in one transaction, so both
    // rows get byte-identical timestamps and an ORDER BY createdAt with no
    // tiebreaker returns them in arbitrary (heap/scan) order — confirmed
    // this actually flips in practice, not just in theory. A monotonic
    // bigserial sorts correctly regardless of same-transaction timestamps.
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Composite, not conversationId alone: the only query this feature runs
  // is WHERE conversation_id = $1 ORDER BY seq ASC (listMessages) — a
  // conversationId-only index still leaves Postgres sorting the matched
  // rows separately. (conversationId, seq) serves the filter and the sort
  // in one index scan.
  (table) => [index('copilot_messages_conversation_id_seq_idx').on(table.conversationId, table.seq)],
);

export const copilotProposalKindEnum = pgEnum('copilot_proposal_kind', [
  'comment',
  'state_change',
  'assignee_change',
  'priority_change',
  'create_work_item',
]);

// The full lifecycle a proposal row can move through. 'executing' is a
// short-lived claim state (see proposals.service.ts's approveProposal) that
// exists so two concurrent approves can never both execute the same write —
// only the one whose conditional UPDATE wins the claim proceeds.
export const copilotProposalStatusEnum = pgEnum('copilot_proposal_status', [
  'proposed',
  'executing',
  'executed',
  'rejected',
  'stale',
  'expired',
  'superseded',
]);

// One row per propose_* MCP tool call (issue #10 / Copilot V2). The model
// never executes anything: it writes one of these rows, the renderer shows
// it as an approval card, and only a user's explicit approve triggers the
// real service-layer write.
export const copilotProposals = pgTable(
  'copilot_proposals',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => copilotConversations.id, { onDelete: 'cascade' }),
    kind: copilotProposalKindEnum('kind').notNull(),
    // Deliberately NOT an FK to tickets: a proposal against a
    // since-deleted ticket must survive as a row so approve can report it
    // STALE ("no longer available") rather than the card silently vanishing
    // from the transcript via a cascade. Null only for create_work_item.
    ticketId: text('ticket_id'),
    // The kind-specific execute arguments (e.g. { stateId } for a state
    // change) — what approve actually passes to the service layer.
    payload: jsonb('payload').notNull(),
    // Display + staleness data captured at propose time (names, colors,
    // from-values) — what the card renders, and what approve re-checks the
    // live row against before executing.
    snapshot: jsonb('snapshot').notNull(),
    // max(copilot_messages.seq) in the conversation at propose time — pins
    // the card's position in the transcript (it renders after the assistant
    // reply of the turn that proposed it). bigint to match seq's bigserial.
    anchorSeq: bigint('anchor_seq', { mode: 'number' }).notNull(),
    status: copilotProposalStatusEnum('status').notNull().default('proposed'),
    // Human-readable reason for a terminal non-executed status (stale/
    // expired), surfaced verbatim on the card.
    statusReason: text('status_reason'),
    // What execution produced (a commentId, a created ticket's id and
    // identifier) — null until executed.
    resultInfo: jsonb('result_info'),
    // createdAt + 24h, computed in the service (not a DB default) so the
    // TTL constant lives in exactly one place.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set once the resolved outcome has been delivered back to the model in
    // a later turn's preamble — the "un-notified resolved" query keys off
    // this being null.
    modelNotifiedAt: timestamp('model_notified_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The one hot query is listProposals's WHERE conversation_id = $1 ORDER BY
  // created_at — same reasoning as copilot_messages' composite index above.
  (table) => [
    index('copilot_proposals_conversation_id_created_at_idx').on(table.conversationId, table.createdAt),
  ],
);
