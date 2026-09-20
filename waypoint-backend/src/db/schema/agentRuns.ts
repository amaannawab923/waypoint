import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
import { copilotConversations } from './copilot.js';
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
    // Nullable since W4b (ROAD-116): an independent session on a folder
    // that is no project's linked repository belongs to no project. Since
    // W5b (ROAD-126) a dispatched run may have none too: a run on a Jira
    // issue works in whatever repository the person mapped that Jira
    // project to, and only has a project when that folder is some
    // project's linked repository.
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    // Null for an independent session that is not about a ticket. A ticket
    // may have many runs over time (retries, follow-ups); a run has at most
    // one ticket.
    //
    // W5b (ROAD-126): the id names EITHER a native ticket ("wi-…",
    // tickets.id) OR a Jira issue's ledger handle ("tref-…",
    // ticket_refs.id) — exactly the rule proposals.ticket_id follows, and
    // for its reason (see providerOf in proposals.service.ts): the prefix
    // alone says which system owns the ticket, with nothing stored beside
    // it able to disagree. That is why the foreign key to `tickets` is gone
    // (migration 0019) and a shape check stands in its place: a column
    // that can name two tables cannot reference one. What the FK gave —
    // `set null` when a native ticket is deleted — the service keeps at
    // insert (createRun checks the ticket, or the ref, exists) and the
    // panel tolerates on read (a label that cannot be resolved falls back
    // to the run's title and branch). A deleted ticket leaves its runs
    // readable, as before.
    ticketId: text('ticket_id'),
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
    // Where the agent works (W4b, ROAD-116): `worktree` — a fresh worktree
    // Waypoint provisions and owns (every dispatched run; the default for
    // an independent run on a git repository); `directory` — the folder
    // the person picked, edited in place, like Claude Code desktop.
    isolation: text('isolation').notNull().default('worktree'),
    // The directory the agent runs in, once known: the worktree's
    // canonical path for a worktree run, the picked folder for a direct
    // one. The panel names a run by this when it has no branch.
    cwd: text('cwd'),
    // Started in the provider's bypass-permissions mode: the session asks
    // nothing. Shown on the row so an unattended agent is never invisible.
    autoApprove: boolean('auto_approve').notNull().default(false),
    // The provider session mode the run was started in (`plan`,
    // `bypassPermissions`), exactly as handed to `acp.start` — so a resume
    // restarts the session the way it was started (W5a: Investigate is
    // plan mode whatever auto-approve says). Null = the provider's default.
    modeId: text('mode_id'),
    // What a dispatched run was asked to do (W5a, ROAD-117): `investigate`
    // (find the root cause, plan mode, change nothing), `fix` (implement
    // it), `custom` (the person's own instruction). Null for an
    // independent run. The intent is what host-side finalize files and
    // what the metrics split on.
    intent: text('intent'),
    // The Copilot conversation a dispatched run's notes go back to: the one
    // it was dispatched from, when there was one. Null → the member's
    // latest conversation at note time.
    copilotConversationId: text('copilot_conversation_id').references(() => copilotConversations.id, {
      onDelete: 'set null',
    }),

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
    // What the session concluded, in Waypoint's vocabulary (W5c):
    // `root-cause` | `fixed` | `partial` | `not-a-bug` | `wont-fix` |
    // `needs-info`. Read by host finalize from the report's `Verdict:` line
    // (the verb's default when the session named none); it decides which
    // state change finalize proposes and is what Copilot's offer on the
    // next dispatch reads back. Null for an independent run or one that
    // never finished.
    verdict: text('verdict'),

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
    // Set once, on entering a terminal status; cleared by updateRun once a
    // reopenRun-initiated continuation actually reaches `running` again —
    // NOT nulled by reopenRun itself, so a reopen that never completes
    // still carries when this run last stopped.
    endedAt: timestamp('ended_at', { withTimezone: true }),
    // How many times reopenRun has continued this run, and when it last
    // did — audit facts (never-lock, 2026-09-20: no longer a throttle).
    // Never touched by the general PATCH route (not in updateAgentRunSchema).
    reopenCount: integer('reopen_count').notNull().default(0),
    lastReopenedAt: timestamp('last_reopened_at', { withTimezone: true }),
    // Never-lock: how many times the host's finalize has filed this run's
    // report (0 = never), and the branch HEAD it last filed at. A
    // continued run's later turns file again only on an explicit report
    // (finalize.ts, report-triggered); the sha is for the "N new commits,
    // not published" marker, never for the trigger.
    finalizeCount: integer('finalize_count').notNull().default(0),
    finalizedHeadSha: text('finalized_head_sha'),
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
    // A retry supersedes the run it names; the drawer shows the chain.
    index('agent_runs_retry_of_run_id_idx').on(t.retryOfRunId),
    // W5b: a ticket id is a native ticket's or a Jira ref's, never a bare
    // key or anything else — the shape the service dispatches on.
    check(
      'agent_runs_ticket_id_shape',
      sql`${t.ticketId} IS NULL OR ${t.ticketId} LIKE 'wi-%' OR ${t.ticketId} LIKE 'tref-%'`,
    ),
    // There is deliberately NO one-live-writer-per-ticket index any more
    // (never-lock, 2026-09-20): any number of conversations may be live on
    // one ticket. What stays single — one automatic dispatch, one
    // publisher — is held by createRun's and claimPublish's transaction-
    // scoped advisory lock on the ticket (agentRuns.service.ts), which is
    // what actually serializes across processes.
  ],
);

// Never-lock (2026-09-20): a message that could not be handed to the
// daemon right now — the session is still starting, finalize holds the
// row, the worktree's folder or repository is not reachable, the spawn
// failed, or the sender is not the owner whose Waypoint runs the session
// — is accepted here instead of refused, and delivered at most once when
// it can be. A row has state, which is why this is a table and not only
// events (events are appended alongside for the transcript's markers).
export const agentRunPendingPrompts = pgTable(
  'agent_run_pending_prompts',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    // FIFO position, minted under the run's row lock.
    seq: integer('seq').notNull(),
    byMemberId: text('by_member_id')
      .notNull()
      .references(() => members.id),
    text: text('text').notNull(),
    // starting | finishing | folder-missing | repository-missing | spawn-failed | owner-offline
    reason: text('reason').notNull(),
    // queued | sending | delivered | unresolved | dropped
    state: text('state').notNull().default('queued'),
    // Automatic drains that ended spawn-failed for this item; any user
    // send on the run resets it. The only runaway guard left.
    autoAttempts: integer('auto_attempts').notNull().default(0),
    lastError: text('last_error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_run_pending_prompts_run_idx').on(t.runId, t.seq)],
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

// W5a follow-up (ROAD-124): the transcript, durably. The daemon holds a
// session's history in memory only — a daemon restart, or the kill that
// ends a finalized run, loses it — and a run's transcript is the evidence
// its proposals rest on. Main snapshots the committed turns (acp.getHistory,
// as the daemon serialises them) after every turn and before every kill;
// the panel reads this when the daemon has nothing. One row per run,
// replaced whole: the turns are the daemon's own shape, kept opaque here.
export const agentRunTranscripts = pgTable('agent_run_transcripts', {
  runId: text('run_id')
    .primaryKey()
    .references(() => agentRuns.id, { onDelete: 'cascade' }),
  turns: jsonb('turns').notNull().default([]),
  turnCount: integer('turn_count').notNull().default(0),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
});
