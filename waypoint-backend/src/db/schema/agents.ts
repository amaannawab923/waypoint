import { pgTable, text, boolean, timestamp, pgEnum, primaryKey, unique } from 'drizzle-orm/pg-core';
import { workspaces, members } from './workspace.js';
import { projects } from './projects.js';
import { tickets } from './tickets.js';

export const executionMethodEnum = pgEnum('execution_method', [
  'local-claude-subscription',
  'local-codex-subscription',
  'local-gemini-subscription',
  'hosted-api-key',
]);
export const agentAutonomyEnum = pgEnum('agent_autonomy', [
  'plan-only',
  'ask-before-write',
  'ask-before-pr',
  'full-auto',
]);
// Shared by agent_assignments.status (a projection of the latest run —
// architecture §5.4) and agent_runs.status (the run itself, ROAD-53). The
// four values migration 0012 added — provisioning, finishing, interrupted,
// cancelled — are the coding-run lifecycle; what each means, and which
// moves between them are legal, is documented on agentRuns.ts and enforced
// by runStatusMachine.ts. Order here is display order; drizzle-kit
// realises an enum change as a detour through text (cast both columns to
// text, DROP TYPE, CREATE TYPE in this order, cast back — see 0012), so
// the enum's order is this list's order and nothing sorts on it anyway.
export const agentRunStatusEnum = pgEnum('agent_run_status', [
  'queued',
  'provisioning',
  'running',
  'blocked',
  'finishing',
  'needs-review',
  'done',
  'interrupted',
  'failed',
  'cancelled',
]);

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  avatarColor: text('avatar_color').notNull(),
  // AgentInstructionsFile flattened — always exactly one file, two plain
  // columns beat jsonb here.
  instructionsFilename: text('instructions_filename').notNull(),
  instructionsContentMarkdown: text('instructions_content_markdown').notNull(),
  scopeAllProjects: boolean('scope_all_projects').notNull().default(true),
  executionMethod: executionMethodEnum('execution_method').notNull(),
  model: text('model').notNull(),
  autonomy: agentAutonomyEnum('autonomy').notNull(),
  // Small controlled vocabulary, never filtered in SQL — plain array.
  triggers: text('triggers').array().notNull(),
  templateId: text('template_id'),
  isActive: boolean('is_active').notNull().default(true),
  createdById: text('created_by_id')
    .notNull()
    .references(() => members.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Only meaningful when scopeAllProjects = false. Real FK integrity: deleting
// a project silently drops it from every agent's scope, and "which agents
// can touch project X" is a real query automation will need in SQL.
export const agentProjectScopes = pgTable(
  'agent_project_scopes',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.projectId] })],
);

// unique(ticket_id, agent_id) is exactly the row ensureAgentAssignment's
// find-or-create logic in the mock depends on.
export const agentAssignments = pgTable(
  'agent_assignments',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: agentRunStatusEnum('status').notNull().default('queued'),
    summary: text('summary'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.ticketId, t.agentId)],
);
