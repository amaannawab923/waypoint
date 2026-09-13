// The legal moves of an agent run's `status` — ROAD-54. Pure: no I/O, so
// the whole table is unit-testable and the service can't drift from it.
//
// What each status means is documented once, on db/schema/agentRuns.ts.
// This file only says which arrows exist. The service refuses any other
// move with a 409 and records every accepted one as a `status_changed`
// event in the same transaction, so the ledger and the audit trail agree
// by construction.

export const AGENT_RUN_STATUSES = [
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
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

const TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  // Asked for; nothing has happened. A cancel here costs nothing.
  queued: ['provisioning', 'failed', 'cancelled'],
  // Worktree being created, session being started. `interrupted` when
  // Waypoint went away mid-provision — the worktree may or may not exist,
  // which is exactly the kind of thing reconcile (ROAD-57) looks at rather
  // than guesses.
  provisioning: ['running', 'interrupted', 'failed', 'cancelled'],
  running: ['blocked', 'finishing', 'interrupted', 'failed', 'cancelled'],
  // Waiting on a person. The answer sends it back to running; there is no
  // shortcut to finishing — a blocked agent has not finished anything.
  blocked: ['running', 'interrupted', 'failed', 'cancelled'],
  // The agent is done; host-side push / PR / proposals in flight (W6).
  // `cancelled` is a person giving up on a push that hangs — the finalize
  // steps are idempotent, so stopping them midway loses nothing that a
  // retry cannot redo (found in review).
  finishing: ['needs-review', 'done', 'interrupted', 'failed', 'cancelled'],
  // Left proposals a person has not decided. `done` once the last one is
  // resolved (W6 writes that); nothing else can happen to a run that has
  // already finished.
  'needs-review': ['done'],
  done: [],
  // Not terminal: the daemon or Waypoint went away, the worktree is still
  // there, and Resume (ROAD-69) re-provisions or re-attaches. Giving up on
  // it is `cancelled` (a person) or `failed` (the resume itself failed).
  interrupted: ['provisioning', 'running', 'failed', 'cancelled'],
  failed: [],
  cancelled: [],
};

/** Ended for good — `ended_at` is set on entering one of these. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'done',
  'failed',
  'cancelled',
]);

/**
 * "The daemon should have a live session for this." What boot-time
 * reconcile (ROAD-57) compares against the daemon's session list; a run in
 * one of these with nothing on the daemon side is `interrupted`.
 */
export const LIVE_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'provisioning',
  'running',
  'blocked',
  'finishing',
]);

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isLive(status: AgentRunStatus): boolean {
  return LIVE_RUN_STATUSES.has(status);
}

/** The sentence a refused move gets — shown as the 409's body. */
export function describeRefusedTransition(from: AgentRunStatus, to: AgentRunStatus): string {
  if (from === to) return `The run is already ${from}.`;
  const allowed = TRANSITIONS[from];
  if (allowed.length === 0) return `A ${from} run is finished; it cannot become ${to}.`;
  return `A ${from} run cannot become ${to}; it can become ${allowed.join(', ')}.`;
}
