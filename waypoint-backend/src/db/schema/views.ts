import { pgTable, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { projects, visibilityEnum } from './projects.js';
import { members } from './workspace.js';

export const savedViews = pgTable('saved_views', {
  id: text('id').primaryKey(),
  // Nullable as of §4.6 (P3b): project scope moved into filters.projectIds,
  // so a view is no longer required to name exactly one project. The
  // column is kept (not dropped) — a view whose filter happens to name
  // exactly one project can still denormalize it here for listing/indexing.
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  // jsonb, but no longer arbitrary shape — validated against
  // ticketFilterSchema (validation/ticketFilter.schema.ts) at the route
  // boundary on every write. jsonb stays the storage type since Drizzle has
  // no first-class "validated JSON" column type.
  filters: jsonb('filters').notNull(),
  visibility: visibilityEnum('visibility').notNull().default('public'),
  isFavorite: boolean('is_favorite').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
