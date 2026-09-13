import { pgTable, text, boolean, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core';

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
  // The coding-agent provider every new session runs on unless the person
  // starting it picks another (W4, emdash's `defaultAgent` rule: a
  // workspace default, a per-session override, never a change mid-
  // session). A plain string — the provider list is the engine's — and
  // null means Waypoint's own default. Availability is per machine and is
  // the renderer's to check; this is only the workspace's preference.
  defaultAgentProvider: text('default_agent_provider'),
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
  // Preferences settings' "First day of the week" select — see
  // profile-settings/Preferences.tsx and the 'preferences.firstDayOfWeek'
  // capability. Nothing reads this to actually change calendar rendering
  // yet (that's what the capability's NotWired note discloses), but the
  // choice itself is now real, persisted state rather than a value that
  // silently reverted on every reload.
  firstDayOfWeek: text('first_day_of_week').notNull().default('Sunday'),
  // NotificationPrefs | null — see profile-settings/Notifications.tsx and
  // the 'profile.notificationPrefs' capability (saved, but nothing sends
  // notifications yet). Nullable like projects.estimate/automations: null
  // means "use the page's own defaults", so a member row from before this
  // column existed doesn't need a backfill.
  notificationPrefs: jsonb('notification_prefs'),
});
