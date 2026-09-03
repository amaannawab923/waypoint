import { pgTable, text, boolean, timestamp, integer, jsonb, pgEnum, primaryKey } from 'drizzle-orm/pg-core';
import { workspaces, members } from './workspace.js';

export const visibilityEnum = pgEnum('visibility', ['public', 'private']);
// No 'triage' group (docs/design/waypoint-revamp-architecture.md §3.3). The
// only fact a triage state carried — that a ticket arrived from outside —
// is now tickets.source, which records it directly instead of encoding it in
// a workflow column every project had to keep and no view ever filtered.
export const stateGroupEnum = pgEnum('state_group', [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
]);

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  identifier: text('identifier').notNull(),
  description: text('description').notNull().default(''),
  icon: text('icon').notNull(),
  coverGradientStart: text('cover_gradient_start').notNull(),
  coverGradientEnd: text('cover_gradient_end').notNull(),
  visibility: visibilityEnum('visibility').notNull().default('public'),
  leadId: text('lead_id').references(() => members.id, { onDelete: 'set null' }),
  defaultAssigneeId: text('default_assignee_id').references(() => members.id, { onDelete: 'set null' }),
  timezone: text('timezone').notNull(),
  // ProjectEstimateSystem | null
  estimate: jsonb('estimate'),
  // ProjectAutomations
  automations: jsonb('automations').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  guestAccessEnabled: boolean('guest_access_enabled').notNull().default(false),
  // A capability the project owner sets ("accept submissions from outside"),
  // distinct from the removed per-primitive feature toggles
  // (docs/design/waypoint-revamp-architecture.md §3.4). The sidebar shows
  // Requests when this is true OR primitiveCounts.requests > 0 — a project
  // can have real inbound requests even with the form never explicitly
  // enabled, and a project with the form enabled but nothing submitted yet
  // should still show the entry so the owner can find it.
  acceptsRequests: boolean('accepts_requests').notNull().default(false),
  // Absolute path to the project's local git checkout, so Copilot can read
  // real code (Copilot V3). Null means "not linked" — the same
  // absent-is-unset convention leadId/defaultAssigneeId/estimate use.
  repoPath: text('repo_path'),
});

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.memberId] })],
);

export const ticketStates = pgTable('ticket_states', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  group: stateGroupEnum('group').notNull(),
  color: text('color').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const labels = pgTable('labels', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull(),
});
