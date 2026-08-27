import { pgTable, text, timestamp, pgEnum, bigserial, index } from 'drizzle-orm/pg-core';
import { members } from './workspace.js';

export const copilotMessageRoleEnum = pgEnum('copilot_message_role', ['user', 'assistant']);

// One conversation per member for now — see copilot.service.ts's
// getOrCreateConversation. Multi-thread history is a later phase (issue #11).
// unique() on memberId makes get-or-create atomic via onConflictDoNothing()
// instead of a select-then-insert race that could otherwise create more
// than one "the" conversation for the same member under concurrent first
// requests (e.g. a panel firing GET and POST together on first open).
export const copilotConversations = pgTable('copilot_conversations', {
  id: text('id').primaryKey(),
  memberId: text('member_id')
    .notNull()
    .unique()
    .references(() => members.id, { onDelete: 'cascade' }),
  // The Claude Code CLI's own session id (issue #7) — passed back to `claude
  // -p ... --resume <id>` so a conversation's later turns continue the same
  // Claude Code session instead of starting fresh each message. Null until
  // the first assistant reply ever completes.
  claudeSessionId: text('claude_session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
