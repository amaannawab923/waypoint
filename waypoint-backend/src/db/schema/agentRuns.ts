import {
  pgTable,
  pgEnum,
  text,
  integer,
  bigint,
  numeric,
  jsonb,
  timestamp,
  index,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { members } from './workspace.js';
import { projects } from './projects.js';
import { tickets } from './tickets.js';
import { agents, agentRunStatusEnum } from './agents.js';

// The session ledger — ROAD-53, W2 of the agent-sessions epic (ROAD-44).
//
// One row per coding run, whichever way it started: a user opening a
// session on a linked repo ('independent') or a ticket dragged onto Copilot
// ('dispatched'). Postgres owns THIS — who asked for what, on which ticket,
// in which worktree, with what outcome. The emdash daemon owns the live
// process (the ACP session, the worktree on disk); the two reconcile at boot
// (ROAD-57). Nothing here is a desired state the daemon converges toward:
// every column is a fact something observed and wrote down.
//
// The status vocabulary lives on `agent_run_status`, the enum
// `agent_assignments.status` already uses, extended (migration 0012) rather
// than duplicated: the architecture doc (§5.4) makes an assignment's status
// a projection of its latest run, and a projection over the same enum is a
// plain copy. Each value is a sentence the panel can show (ROAD-54 —
// "the backend should not invent states the UI cannot represent"):
//
//   queued        asked for, nothing has happened yet
//   provisioning  worktree being created, session being started
//   running       the agent is working
//   blocked       waiting on a person — a permission request, a question
//   finishing     the agent is done; host-side push/PR/proposals in flight
//   needs-review  finished, and left proposals a person has not decided yet
//   done          finished, everything it produced is resolved
//   interrupted   Waypoint or the daemon went away mid-run; resumable
//   failed        ended in an error
//   cancelled     a person stopped it
//
// The legal moves between them are runStatusMachine.ts's — the service
// refuses the rest with a 409, and every accepted move is also an
// `agent_run_events` row, so the audit trail is the same transaction as
// the state change and cannot disagree with it.

export const agentRunEntryEnum = pgEnum('agent_run_entry', [
  'independent', // the user opened it on a repo; they answer its questions
  'dispatched', // Copilot started it from a ticket; the autonomy policy answers first
]);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(), // 'run-…'

    // --- who, where, about what ------------------------------------------
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Null for an independent session that is not about a ticket. A ticket
    // may have many runs over time (retries, follow-ups); a run has at most
    // one ticket. Never cascaded: a deleted ticket leaves its runs readable.
    ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    // The account column ahead of ROAD-7's login. Every run has an owner —
    // the panel lists the owner's runs, and only the owner answers an
    // independent run's permission requests. `restrict`: a member with runs
    // on record is not a member you can delete without deciding about them.
    ownerMemberId: text('owner_member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'restrict' }),
    // Set when a dispatched run acted on behalf of a configured agent (the
    // `agents` table's autonomy policy). Null for independent sessions and
    // for a dispatch that used Copilot's own defaults. Denormalised onto
    // proposals.agent_id at propose time, same as today.
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    entry: agentRunEntryEnum('entry').notNull(),
    // What the user called the session when starting it (W4, ROAD-67),
    // if anything. The panel names a run by its ticket, else this, else
    // its branch. Never written by the agent — `summary` is its.
    title: text('title'),
    // Which engine provider ran it — 'claude', 'codex', … — a plain string
    // because the provider list is the daemon's registry, not this schema's.
    providerId: text('provider_id').notNull(),

    // --- the daemon's handles, once it has them ---------------------------
    // The daemon's workspace-registry record for the run's worktree, and its
    // ACP conversation id. Both null until provisioning writes them; both
    // are what ROAD-57's reconcile matches against after a restart.
    daemonWorkspaceId: text('daemon_workspace_id'),
    daemonSessionId: text('daemon_session_id'),
    // The provider's own resume handle — Claude's session UUID — exactly
    // as the daemon's `acp.start` answered it (W4, ROAD-69). Null until a
    // session has started; rewritten on every resume, because a resume the
    // provider could not restore is a fresh session with a new id. Resume
    // hands it back to the daemon; nothing else reads it.
    providerSessionId: text('provider_session_id'),
    worktreePath: text('worktree_path'),
    branch: text('branch'),
    baseRef: text('base_ref'),
    prUrl: text('pr_url'),

    // --- state -------------------------------------------------------------
    status: agentRunStatusEnum('status').notNull().default('queued'),
    // What a blocked run is waiting on, as a sentence for the panel
    // ("Wants to run `npm test`", "Asked: which API version?"). Cleared on
    // leaving `blocked`.
    blockedReason: text('blocked_reason'),
    errorKind: text('error_kind'), // 'provision' | 'session' | 'timeout' | 'generic' …
    errorMessage: text('error_message'),
    // The agent's final message, capped by the service — never the whole
    // transcript (that is the daemon's, read live).
    summary: text('summary'),

    // --- counters ----------------------------------------------------------
    turnCount: integer('turn_count').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    // Null until the provider reported one; not every provider does.
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),

    // A retry is a NEW row pointing at the one it retries — never an update
    // of the first run's worktree_path or outcome (ROAD-56: runs are rows,
    // not upserts; the first attempt's evidence stays intact).
    retryOfRunId: text('retry_of_run_id').references((): AnyPgColumn => agentRuns.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // First entry into `running`; null while queued/provisioning.
    startedAt: timestamp('started_at', { withTimezone: true }),
    // Set once, on entering a terminal status.
    endedAt: timestamp('ended_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The panel: "my runs, newest first" and "this project's runs".
    index('agent_runs_owner_created_idx').on(t.ownerMemberId, t.createdAt),
    index('agent_runs_project_created_idx').on(t.projectId, t.createdAt),
    // The ticket drawer: "this ticket's runs".
    index('agent_runs_ticket_idx').on(t.ticketId),
    // Boot-time reconcile: "every run that thinks it is live".
    index('agent_runs_status_idx').on(t.status),
  ],
);

// Append-only, per run: the audit trail ROAD-3 asked for, written by the
// same transactions that change the run. `seq` is assigned by the service
// under the run's row lock (never by the client), so two writers cannot
// mint the same number and the order of events is the order they were
// accepted, not the order clocks happened to agree on. Never updated, never
// deleted except by the run's own cascade.
export const agentRunEvents = pgTable(
  'agent_run_events',
  {
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    // A small vocabulary the service owns (agentRuns.service.ts's
    // AgentRunEventKind) — text in the column so a new kind is a code
    // change, not a migration.
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);
