import { pgTable, text, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const planTierEnum = pgEnum('plan_tier', ['community', 'pro', 'business', 'enterprise']);
export const memberRoleEnum = pgEnum('member_role', ['admin', 'member', 'guest']);
export const authMethodEnum = pgEnum('auth_method', ['email', 'google', 'github', 'gitlab', 'gitea']);

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  companySize: text('company_size').notNull(),
  timezone: text('timezone').notNull(),
  plan: planTierEnum('plan').notNull().default('community'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  restrictWorkspaceCreation: boolean('restrict_workspace_creation').notNull().default(false),
});

export const members = pgTable('members', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  displayName: text('display_name').notNull(),
  email: text('email').notNull().unique(),
  avatarColor: text('avatar_color').notNull(),
  role: memberRoleEnum('role').notNull().default('member'),
  authMethod: authMethodEnum('auth_method').notNull().default('email'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
});
