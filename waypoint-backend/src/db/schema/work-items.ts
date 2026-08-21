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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { projects, workItemStates, labels } from './projects.js';
import { workModules, cycles } from './modules-cycles.js';
import { members } from './workspace.js';

export const priorityEnum = pgEnum('priority', ['urgent', 'high', 'medium', 'low', 'none']);
export const assigneeKindEnum = pgEnum('assignee_kind', ['member', 'agent']);

export const workItems = pgTable(
  'work_items',
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
      .references(() => workItemStates.id, { onDelete: 'restrict' }),
    priority: priorityEnum('priority').notNull().default('none'),
    moduleId: text('module_id').references(() => workModules.id, { onDelete: 'set null' }),
    cycleId: text('cycle_id').references(() => cycles.id, { onDelete: 'set null' }),
    parentId: text('parent_id').references((): AnyPgColumn => workItems.id, { onDelete: 'set null' }),
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

export const workItemLinks = pgTable('work_item_links', {
  id: text('id').primaryKey(),
  workItemId: text('work_item_id')
    .notNull()
    .references(() => workItems.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workItemLabels = pgTable(
  'work_item_labels',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    labelId: text('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.workItemId, t.labelId] })],
);

// No FK on assigneeId — an assignee id is polymorphic (member OR agent, per
// entities.ts), so no single FK target is possible. Integrity is enforced in
// the service layer, same as the mock's logAssigneeChanges/nameFor() do by
// checking both lists.
export const workItemAssignees = pgTable(
  'work_item_assignees',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    assigneeId: text('assignee_id').notNull(),
    assigneeKind: assigneeKindEnum('assignee_kind').notNull(),
  },
  (t) => [unique().on(t.workItemId, t.assigneeId)],
);

// authorId has no FK — same polymorphic reasoning as workItemAssignees:
// agents post comments too (see mock/seed.ts's agent-authored comments), so
// no single FK target is possible. Validated in the service layer.
export const comments = pgTable('comments', {
  id: text('id').primaryKey(),
  workItemId: text('work_item_id')
    .notNull()
    .references(() => workItems.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  bodyHtml: text('body_html').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// verb is plain text, not a pg enum — ActivityVerb has already grown twice in
// the client codebase, and ALTER TYPE ... ADD VALUE has enough transactional
// caveats to avoid on the fastest-moving field. Validated at the zod layer.
// actorId has no FK — same polymorphic reasoning as comments.authorId above
// (activity entries like 'agent_status_changed' are actored by an agent).
export const activityEntries = pgTable('activity_entries', {
  id: text('id').primaryKey(),
  workItemId: text('work_item_id')
    .notNull()
    .references(() => workItems.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  verb: text('verb').notNull(),
  detail: text('detail').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
