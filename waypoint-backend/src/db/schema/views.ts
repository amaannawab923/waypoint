import { pgTable, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { projects, networkEnum } from './projects.js';
import { members } from './workspace.js';

export const savedViews = pgTable('saved_views', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  // Record<string, unknown> — genuinely arbitrary shape, jsonb is the only sane choice
  filters: jsonb('filters').notNull(),
  visibility: networkEnum('visibility').notNull().default('public'),
  isFavorite: boolean('is_favorite').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
