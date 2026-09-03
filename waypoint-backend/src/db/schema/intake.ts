import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { priorityEnum, tickets } from './tickets.js';

export const intakeStatusEnum = pgEnum('intake_status', ['pending', 'accepted', 'declined', 'duplicate']);

export const intakeRequests = pgTable('intake_requests', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: intakeStatusEnum('status').notNull().default('pending'),
  priority: priorityEnum('priority'),
  sourceName: text('source_name').notNull(),
  sourceEmail: text('source_email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  linkedTicketId: text('linked_ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
});
