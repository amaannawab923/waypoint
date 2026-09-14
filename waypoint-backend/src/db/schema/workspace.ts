import { pgTable, text, boolean, integer, timestamp, jsonb, pgEnum, unique } from 'drizzle-orm/pg-core';

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
  // AT7 (ROAD-142). The mode signal for "is this workspace Personal or a
  // real Team": true only on the seeded ws-1 row that a fresh install
  // runs against without ever signing in. A Team workspace — created at
  // the invite click (AT12) — is never personal. Carried as a plain flag
  // rather than inferred from an external org id, per
  // docs/design/self-hosted-auth-and-multitenancy.md §3.
  isPersonal: boolean('is_personal').notNull().default(false),
  // How many days of Review / run history stay searchable. 30 is the free
  // plan's window (docs/decisions/002 §1); a paid plan raises it. Nothing
  // enforces this yet — AT6 (ROAD-140) does. Nullable-by-default would
  // mean "unlimited", so the default is the free window, not null.
  reviewHistoryDays: integer('review_history_days').notNull().default(30),
});

// AT7 (ROAD-142). One row per real person on this instance, independent
// of any workspace — this is what a session token points at. Personal
// gets one too: the first-launch profile screen (decision 001 §3) creates
// a local, unverified row so everything is attributed to a user id from
// day one. The browser sign-in (AT9/AT10) later *links* that row —
// setting emailVerifiedAt and authProviderId — rather than creating a
// second identity.
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  authMethod: authMethodEnum('auth_method').notNull().default('email'),
  // Null until a browser sign-in has proven this email (or the provider
  // vouched for it). A local profile is a real users row with this null —
  // that is the whole difference between "mapped" and "verified".
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  // The GitHub / Google subject id. Null for someone who only ever used
  // the email link — email is their identity then.
  authProviderId: text('auth_provider_id'),
  fullName: text('full_name').notNull(),
  avatarUrl: text('avatar_url'),
  // Instance-level admin ("God Mode", AT8): the person who ran first-run
  // setup on a self-hosted instance. Cloud never exposes this.
  isInstanceAdmin: boolean('is_instance_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// AT7 (ROAD-142). A session belongs to a user, not a member: the same
// person holds one session while switching between two workspace
// memberships. Only a SHA-256 of the opaque bearer token is stored —
// never the token itself, same discipline jiraAuth.ts applies to a
// different secret.
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  // What Settings › Devices & Sync (AT6) lists — "MacBook Pro", set by the
  // desktop client at sign-in (AT10).
  deviceLabel: text('device_label'),
});

// AT7 (ROAD-142). Singleton — id is always the literal 'instance'. Holds
// what a self-hosted operator decides at first run (AT8): the instance's
// name and whether anyone may sign up or only invitees. Created here,
// read and written by AT8.
export const instanceSettings = pgTable('instance_settings', {
  id: text('id').primaryKey(),
  instanceName: text('instance_name').notNull().default('Waypoint'),
  // 'open' — anyone who can reach the instance may sign in and create a
  // workspace; 'invite-only' — only people holding an invite link.
  signupMode: text('signup_mode').notNull().default('invite-only'),
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const members = pgTable('members', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  displayName: text('display_name').notNull(),
  // Unique per workspace, not globally — see the table-level constraint
  // below. One person invited to two Teams on one instance is two
  // members rows sharing an email; the global unique this replaced
  // rejected exactly that.
  email: text('email').notNull(),
  avatarColor: text('avatar_color').notNull(),
  role: memberRoleEnum('role').notNull().default('member'),
  authMethod: authMethodEnum('auth_method').notNull().default('email'),
  // AT7 (ROAD-142). The person behind this membership. Personal's seeded
  // mem-1 points at a local, unverified users row (decision 001 §3);
  // null only for a membership that exists before anyone has joined it
  // (an issued invite, AT12). Display fields stay on this row, per
  // membership, so nothing that reads them changes.
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
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
}, (t) => [unique('members_workspace_id_email_unique').on(t.workspaceId, t.email)]);
