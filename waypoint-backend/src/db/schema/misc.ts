import { sql } from 'drizzle-orm';
import { pgTable, text, boolean, timestamp, pgEnum, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces, members } from './workspace.js';
import { tickets, comments } from './tickets.js';
import { agentRuns } from './agentRuns.js';

export const exportStatusEnum = pgEnum('export_status', ['completed', 'processing', 'failed']);
export const notificationKindEnum = pgEnum('notification_kind', [
  'mention',
  'assigned',
  'comment',
  'state_change',
  'agent_needs_review',
  'agent_blocked',
  // Someone replied to your comment. Added with the notifications foundation
  // (0031); its producer ships separately.
  //
  // Migration hazard: drizzle's migrator runs every pending migration in ONE
  // transaction, and Postgres forbids using an enum value in the transaction
  // that added it. So no later migration's SQL (a backfill, an index
  // predicate, a CHECK) may mention 'reply', or a database that is behind on
  // both would fail with "unsafe use of new value". Producers in app code
  // are fine.
  'reply',
]);

/**
 * Structured, display-only facts a notification row carries so the client
 * renders its sentence (and stays right when a ticket is renamed) instead of
 * a frozen English string. Snapshots only: the client prefers live ticket
 * data when it has it. Versioned by `v`.
 */
export interface NotificationPayload {
  v?: 1;
  ticketKey?: string;
  ticketTitle?: string;
  projectId?: string;
  /** The comment's words, formatting stripped (lib/commentSnippet.ts). */
  snippet?: string;
  /** An `assigned` row written as the ticket was created. */
  created?: boolean;
  /** Grouped rows ("X and 2 others commented…"): every actor folded in. */
  actorIds?: string[];
  count?: number;
  /** A session on a Jira issue, which ticket_id's FK cannot hold. */
  ticketRef?: { system: 'jira'; key: string; summary?: string };
  blockedReason?: string;
  proposalCount?: number;
  fromStateId?: string;
  toStateId?: string;
}

export const scratchNotes = pgTable('scratch_notes', {
  id: text('id').primaryKey(),
  authorId: text('author_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  // AT11 (ROAD-146). Explicit, not just relied on implicitly via
  // authorId — a member id is already unique to one (person, workspace)
  // pairing, so authorId alone happens to already scope correctly, but
  // an explicit column matches the same defense-in-depth every other
  // project-adjacent table in this file already carries, and is what
  // the workspace-scoping audit specifically asked for here.
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  color: text('color').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    // No FK — an agent can be the actor (e.g. 'agent_needs_review'), same
    // polymorphic reasoning as activity_entries.actorId/comments.authorId.
    // recipientId stays FK'd: only members ever receive notifications.
    actorId: text('actor_id').notNull(),
    ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    // The exact comment a row deep-links to (#comment-<id>). A deleted
    // comment leaves the row pointing at its ticket instead of vanishing.
    commentId: text('comment_id').references(() => comments.id, { onDelete: 'set null' }),
    // Session rows: a run may target a Jira issue (tref-…), which ticket_id
    // cannot hold, so session notifications hang off the run.
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    // Legacy rendered sentence. New rows leave it null and carry `payload`;
    // kept as the fallback for rows written before 0031.
    message: text('message'),
    // Replaces the old `read` boolean: null = unread. The API still exposes
    // `read: boolean`, derived, so callers didn't have to change at once.
    readAt: timestamp('read_at', { withTimezone: true }),
    kind: notificationKindEnum('kind').notNull(),
    // Grouping: while a row with the same (recipient, groupKey) is unread,
    // a new event updates it instead of adding a row. See the unique index.
    groupKey: text('group_key'),
    payload: jsonb('payload').$type<NotificationPayload>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Bumped when a grouped row absorbs a new event; the list's sort key.
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The list: "mine, newest first", keyset-paged on (updated_at, id).
    index('notifications_recipient_updated_idx').on(t.recipientId, t.updatedAt.desc(), t.id.desc()),
    // The bell: "how many unread for me", cheap.
    index('notifications_unread_idx').on(t.recipientId).where(sql`${t.readAt} IS NULL`),
    // At most one OPEN (unread) row per group per recipient, which is what
    // makes "update the open group row, else insert" a race-safe upsert.
    uniqueIndex('notifications_open_group_uq')
      .on(t.recipientId, t.groupKey)
      .where(sql`${t.readAt} IS NULL AND ${t.groupKey} IS NOT NULL`),
  ],
);

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
