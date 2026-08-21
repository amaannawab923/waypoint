import { pgTable, text, date, pgEnum, primaryKey } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { members } from './workspace.js';

export const moduleStatusEnum = pgEnum('module_status', [
  'backlog',
  'planned',
  'in-progress',
  'paused',
  'completed',
  'cancelled',
]);

export const workModules = pgTable('work_modules', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  leadId: text('lead_id').references(() => members.id, { onDelete: 'set null' }),
  status: moduleStatusEnum('status').notNull().default('planned'),
  startDate: date('start_date'),
  targetDate: date('target_date'),
});

export const moduleMembers = pgTable(
  'module_members',
  {
    moduleId: text('module_id')
      .notNull()
      .references(() => workModules.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.moduleId, t.memberId] })],
);

export const cycles = pgTable('cycles', {
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

export const cycleMembers = pgTable(
  'cycle_members',
  {
    cycleId: text('cycle_id')
      .notNull()
      .references(() => cycles.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.cycleId, t.memberId] })],
);
