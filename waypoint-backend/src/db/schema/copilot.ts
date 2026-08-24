import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { members } from './workspace.js';

export const copilotMessageRoleEnum = pgEnum('copilot_message_role', ['user', 'assistant']);

// One conversation per member for now — see copilot.service.ts's
// getOrCreateConversation. Multi-thread history is a later phase (issue #11).
export const copilotConversations = pgTable('copilot_conversations', {
  id: text('id').primaryKey(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const copilotMessages = pgTable('copilot_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => copilotConversations.id, { onDelete: 'cascade' }),
  role: copilotMessageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
