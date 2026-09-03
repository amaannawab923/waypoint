import { pgTable, text, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { workspaces, members } from './workspace.js';
import { tickets } from './tickets.js';

export const exportStatusEnum = pgEnum('export_status', ['completed', 'processing', 'failed']);
export const notificationKindEnum = pgEnum('notification_kind', [
  'mention',
  'assigned',
  'comment',
  'state_change',
  'agent_needs_review',
  'agent_blocked',
]);

export const scratchNotes = pgTable('scratch_notes', {
  id: text('id').primaryKey(),
  authorId: text('author_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  color: text('color').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  recipientId: text('recipient_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  // No FK — an agent can be the actor (e.g. 'agent_needs_review'), same
  // polymorphic reasoning as activity_entries.actorId/comments.authorId.
  // recipientId stays FK'd: only members ever receive notifications.
  actorId: text('actor_id').notNull(),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  message: text('message').notNull(),
  read: boolean('read').notNull().default(false),
  kind: notificationKindEnum('kind').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceExports = pgTable('workspace_exports', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeLabel: text('scope_label').notNull(),
  format: text('format').notNull(),
  status: exportStatusEnum('status').notNull().default('completed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// eventTypes is a small controlled vocabulary (6 literal strings) never
// filtered in SQL — a plain array beats a join table here.
export const webhooks = pgTable('webhooks', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  eventTypes: text('event_types').array().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
