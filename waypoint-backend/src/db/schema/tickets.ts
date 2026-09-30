import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  date,
  pgEnum,
  primaryKey,
  unique,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { projects, ticketStates, labels } from './projects.js';
import { workstreams, sprints } from './workstreams-sprints.js';
import { members } from './workspace.js';

export const priorityEnum = pgEnum('priority', ['urgent', 'high', 'medium', 'low', 'none']);
export const assigneeKindEnum = pgEnum('assignee_kind', ['member', 'agent']);
// Where a ticket came from. Replaces the dropped 'triage' state group
// (§3.3): provenance is a fact about the ticket, not a position in the
// project's workflow, so it belongs on the ticket rather than in a state
// every project had to carry.
export const ticketSourceEnum = pgEnum('ticket_source', ['manual', 'request', 'agent', 'import']);

export const tickets = pgTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    identifier: text('identifier').notNull().unique(),
    sequenceId: integer('sequence_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    stateId: text('state_id')
      .notNull()
      .references(() => ticketStates.id, { onDelete: 'restrict' }),
    priority: priorityEnum('priority').notNull().default('none'),
    source: ticketSourceEnum('source').notNull().default('manual'),
    workstreamId: text('workstream_id').references(() => workstreams.id, { onDelete: 'set null' }),
    sprintId: text('sprint_id').references(() => sprints.id, { onDelete: 'set null' }),
    parentId: text('parent_id').references((): AnyPgColumn => tickets.id, { onDelete: 'set null' }),
    estimatePoints: numeric('estimate_points'),
    estimateValue: text('estimate_value'),
    startDate: date('start_date'),
    dueDate: date('due_date'),
    createdById: text('created_by_id')
      .notNull()
      .references(() => members.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    attachmentCount: integer('attachment_count').notNull().default(0),
    linkCount: integer('link_count').notNull().default(0),
    isDraft: boolean('is_draft').notNull().default(false),
    // Fractional/lexo sort key — the DB equivalent of the mock's array-splice
    // ordering. Reorder = compute the midpoint between the target row and its
    // neighbor; list/board queries `ORDER BY sort_order`.
    sortOrder: numeric('sort_order', { precision: 30, scale: 10 }).notNull().default('0'),
  },
  (t) => [unique().on(t.projectId, t.sequenceId)],
);

export const ticketLinks = pgTable('ticket_links', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ticketLabels = pgTable(
  'ticket_labels',
  {
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    labelId: text('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.labelId] })],
);

// No FK on assigneeId — an assignee id is polymorphic (member OR agent, per
// entities.ts), so no single FK target is possible. Integrity is enforced in
// the service layer, same as the mock's logAssigneeChanges/nameFor() do by
// checking both lists.
export const ticketAssignees = pgTable(
  'ticket_assignees',
  {
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    assigneeId: text('assignee_id').notNull(),
    assigneeKind: assigneeKindEnum('assignee_kind').notNull(),
  },
  (t) => [unique().on(t.ticketId, t.assigneeId)],
);

// authorId has no FK — same polymorphic reasoning as ticketAssignees:
// agents post comments too (see mock/seed.ts's agent-authored comments), so
// no single FK target is possible. Validated in the service layer.
//
// ROAD-162: brought this table to parity with the Jira comment surface
// (JiraTicketDetail.tsx) — edit, one-level reply threading, reactions.
//   - updatedAt is null until the first edit, and stays null forever for a
//     comment nobody has touched — that's what lets the frontend show an
//     "(edited)" marker only when it's true, rather than a timestamp that
//     merely duplicates createdAt.
//   - parentId is a self-FK, `onDelete: 'set null'` rather than cascade:
//     deleting a comment must not silently take its replies with it. A
//     reply whose parent was deleted becomes its own root in the thread
//     view (groupCommentsIntoThreads' orphan handling), which is a more
//     honest outcome than vanishing content nobody asked to remove.
export const comments = pgTable('comments', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  bodyHtml: text('body_html').notNull(),
  parentId: text('parent_id').references((): AnyPgColumn => comments.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  // A ticket's thread, and who has commented on it (notification
  // followers) — both read by ticket, which only the pkey covered before.
  index('comments_ticket_idx').on(t.ticketId),
]);

// ROAD-162. One row per (comment, actor, emoji) — the unique constraint is
// what makes "toggle" idempotent and race-safe: two rapid clicks from the
// same actor on the same emoji either both no-op past the first insert or
// cleanly delete-then-reinsert, never double-count. actorId has no FK for
// the same polymorphic reason comments.authorId doesn't (an agent could in
// principle react too, even though nothing mints that today) — validated
// against currentMemberId() in the service layer instead.
export const commentReactions = pgTable(
  'comment_reactions',
  {
    id: text('id').primaryKey(),
    commentId: text('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.commentId, t.actorId, t.emoji)],
);

// verb is plain text, not a pg enum — ActivityVerb has already grown twice in
// the client codebase, and ALTER TYPE ... ADD VALUE has enough transactional
// caveats to avoid on the fastest-moving field. Validated at the zod layer.
// actorId has no FK — same polymorphic reasoning as comments.authorId above
// (activity entries like 'agent_status_changed' are actored by an agent).
export const activityEntries = pgTable('activity_entries', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  verb: text('verb').notNull(),
  detail: text('detail').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ROAD-162 attachments. One row per uploaded file. The BYTES never live
// here — only the metadata; lib/attachmentStore.ts owns the file on disk,
// named from `id` alone (see that file for why the client-supplied
// `filename` is display-only and can never reach a path).
//
//   - ticketId cascades: an attachment has no meaning without its ticket,
//     and tickets.service.ts's deleteTicket unlinks the files just before
//     letting this cascade take the rows.
//   - commentId is NULLABLE on purpose — that null IS the lifecycle. A
//     file uploaded from the composer belongs to the ticket immediately
//     (so a half-written comment that is never posted still has somewhere
//     to hang, and so the upload can happen before the comment that will
//     own it exists at all) and is "claimed" by a comment only when that
//     comment is posted or edited. An edit that drops a file releases it
//     back to commentId = null rather than deleting it — the person may
//     still want it, and a destructive edit is not what "remove from this
//     comment" means.
//   - commentId cascades too, so no DB-level path (including comments'
//     own ticket cascade) can leave a row pointing at a comment that is
//     gone. comments.service.ts's deleteComment still deletes the rows
//     and files explicitly first — a cascade can't unlink a file.
//   - uploaderId has no FK, the same polymorphic reasoning as
//     comments.authorId above; delete authorization compares it to
//     currentMemberId() in the service layer.
export const attachments = pgTable('attachments', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  commentId: text('comment_id').references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
  uploaderId: text('uploader_id').notNull(),
  // The ORIGINAL, client-supplied name, sanitized for display only
  // (lib/attachmentStore.ts's sanitizeFilename). Never used to build a
  // path, never used to build a header without percent-encoding.
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  // The byte length actually written to disk, not anything the client
  // claimed in a header — see attachments.service.ts's uploadAttachment.
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
