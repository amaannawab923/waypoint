import { pgTable, text, boolean, timestamp, pgEnum, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { members } from './workspace.js';

export const pageVisibilityEnum = pgEnum('page_visibility', ['public', 'private', 'archived']);

export const pages = pgTable('pages', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  icon: text('icon').notNull(),
  contentHtml: text('content_html').notNull().default('<p></p>'),
  visibility: pageVisibilityEnum('visibility').notNull().default('private'),
  ownerId: text('owner_id')
    .notNull()
    .references(() => members.id, { onDelete: 'restrict' }),
  isFavorite: boolean('is_favorite').notNull().default(false),
  isLocked: boolean('is_locked').notNull().default(false),
  parentPageId: text('parent_page_id').references((): AnyPgColumn => pages.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
