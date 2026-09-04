import { pgTable, text, date, pgEnum, primaryKey } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { members } from './workspace.js';

// Five values, not the six this enum shipped with (see
// docs/design/waypoint-revamp-architecture.md §3.2 item 19). 'backlog'
// collapsed into 'planned' — a workstream nobody has started is planned,
// and the distinction never drove any UI — while 'in-progress', 'completed'
// and 'cancelled' became 'active', 'done' and 'dropped'.
export const workstreamStatusEnum = pgEnum('workstream_status', [
  'planned',
  'active',
  'paused',
  'done',
  'dropped',
]);

export const workstreams = pgTable('workstreams', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  leadId: text('lead_id').references(() => members.id, { onDelete: 'set null' }),
  status: workstreamStatusEnum('status').notNull().default('planned'),
  startDate: date('start_date'),
  targetDate: date('target_date'),
});

export const workstreamMembers = pgTable(
  'workstream_members',
  {
    workstreamId: text('workstream_id')
      .notNull()
      .references(() => workstreams.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.workstreamId, t.memberId] })],
);

export const sprints = pgTable('sprints', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  leadId: text('lead_id').references(() => members.id, { onDelete: 'set null' }),
});

export const sprintMembers = pgTable(
  'sprint_members',
  {
    sprintId: text('sprint_id')
      .notNull()
      .references(() => sprints.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.sprintId, t.memberId] })],
);
