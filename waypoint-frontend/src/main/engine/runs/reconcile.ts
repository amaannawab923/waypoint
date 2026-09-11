import type {
  DaemonRunsApi,
  DaemonSessionSummary,
  DaemonWorkspaceRecord,
} from './daemonApi';
import type { AgentRun, AgentRunStatus, LedgerClient } from './ledgerClient';

/**
 * Boot-time reconcile: the daemon's live sessions against the ledger's
 * runs that think they are live — ROAD-57.
 *
 * This is the property that decided the architecture (ROAD-44): the
 * daemon outlives Waypoint, so a session the user started before a
 * restart is still running when Waypoint comes back — and the ledger,
 * which Waypoint writes, may be behind. Neither side is corrected toward
 * the other blindly. Each is a set of facts, and the plan below says what
 * a difference between them means:
 *
 *   daemon has it, ledger has it live       re-attach — nothing to fix,
 *                                           note that it was found.
 *   daemon has it, ledger has it interrupted adopt — a previous reconcile
 *                                           wrote `interrupted` while the
 *                                           daemon was down; the daemon
 *                                           auto-resumed it, so the run is
 *                                           running again.
 *   daemon has it, ledger has it finished   the session is stale — the
 *                                           user's Stop / Done landed in
 *                                           the ledger, Waypoint died
 *                                           before the kill. Kill it.
 *   daemon has it, ledger has no row        orphan. Only sessions named
 *                                           like ours (`run-…`) are ours to
 *                                           judge; with no row there is no
 *                                           owner or project to adopt it
 *                                           into, so it is killed. Any
 *                                           other conversation id is left
 *                                           alone — not ours.
 *   ledger has it live, daemon does not     `interrupted`, with whether the
 *                                           worktree is still on disk in
 *                                           the reason — Resume (ROAD-69)
 *                                           re-provisions or re-attaches.
 *
 * Identity is by id, never by guessing from paths: a run's daemon session
 * is the conversation whose id is the run id, and its worktree is the
 * registry record whose id is the run id (worktrees.ts).
 *
 * `planReconcile` is pure — every case above is a unit test — and
 * `reconcileRunsAtBoot` applies the plan, one action at a time, each
 * failure isolated so one bad row cannot stop the rest.
 */

/** Statuses the daemon should have a session for — runStatusMachine's LIVE set. */
export const LIVE_RUN_STATUSES: readonly AgentRunStatus[] = [
  'provisioning',
  'running',
  'blocked',
  'finishing',
];

/** A daemon conversation id that names one of our runs. */
export const RUN_ID_PREFIX = 'run-';

export type ReconcileAction =
  | { kind: 'reattach'; runId: string }
  | { kind: 'adopt'; runId: string }
  | { kind: 'kill-stale'; runId: string; status: AgentRunStatus }
  | { kind: 'kill-orphan'; conversationId: string }
  | {
      kind: 'interrupt';
      runId: string;
      status: AgentRunStatus;
      worktreePresent: boolean;
    }
  | { kind: 'leave'; conversationId: string };

export interface ReconcileInput {
  /** `acp.sessions.list`, by conversation id. */
  sessions: Record<string, Pick<DaemonSessionSummary, 'conversationId'>>;
  /** `workspaceRegistry.records.list`, by record id. */
  workspaces: Record<
    string,
    Pick<DaemonWorkspaceRecord, 'id' | 'observedStatus'>
  >;
  /** Every ledger run in a LIVE status. */
  liveRuns: Pick<AgentRun, 'id' | 'status'>[];
  /** Ledger rows for daemon sessions that are not among `liveRuns` — looked up by id; absent = no row. */
  otherRuns: Record<string, Pick<AgentRun, 'id' | 'status'> | null>;
}

export function planReconcile(input: ReconcileInput): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  const live = new Map(input.liveRuns.map((run) => [run.id, run]));

  // Walk the daemon's sessions first: each is either one of our live runs,
  // one of our not-live runs, or not ours.
  for (const conversationId of Object.keys(input.sessions).sort()) {
    if (!conversationId.startsWith(RUN_ID_PREFIX)) {
      actions.push({ kind: 'leave', conversationId });
      continue;
    }
    const liveRun = live.get(conversationId);
    if (liveRun) {
      actions.push({ kind: 'reattach', runId: conversationId });
      continue;
    }
    const other = input.otherRuns[conversationId];
    if (!other) {
      actions.push({ kind: 'kill-orphan', conversationId });
    } else if (other.status === 'interrupted') {
      actions.push({ kind: 'adopt', runId: other.id });
    } else {
      actions.push({
        kind: 'kill-stale',
        runId: other.id,
        status: other.status,
      });
    }
  }

  // Then the ledger's live runs the daemon knows nothing about.
  for (const run of [...input.liveRuns].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (run.id in input.sessions) continue;
    const workspace = input.workspaces[run.id];
    actions.push({
      kind: 'interrupt',
      runId: run.id,
      status: run.status,
      worktreePresent: workspace?.observedStatus === 'present',
    });
  }
  return actions;
}

export interface ReconcileDeps {
  daemon: DaemonRunsApi;
  ledger: LedgerClient;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

export interface ReconcileReport {
  actions: ReconcileAction[];
  /** Actions whose application threw, with the message. The plan still ran to the end. */
  failures: Array<{ action: ReconcileAction; message: string }>;
}

async function applyAction(
  deps: ReconcileDeps,
  action: ReconcileAction,
): Promise<void> {
  switch (action.kind) {
    case 'leave':
      return;
    case 'reattach':
      await deps.ledger.appendEvent(action.runId, 'session_resumed', {
        at: 'boot',
        note: 'daemon session found live; re-attached',
      });
      return;
    case 'adopt':
      await deps.ledger.updateRun(action.runId, {
        status: 'running',
        reason: 'daemon session found live at boot; the daemon resumed it',
        daemonSessionId: action.runId,
      });
      await deps.ledger.appendEvent(action.runId, 'session_resumed', {
        at: 'boot',
        note: 'daemon resumed the session while Waypoint was away',
      });
      return;
    case 'kill-stale':
      await deps.daemon.killSession(action.runId);
      await deps.ledger.appendEvent(action.runId, 'session_ended', {
        at: 'boot',
        note: `run was already ${action.status}; stale daemon session killed`,
      });
      return;
    case 'kill-orphan':
      await deps.daemon.killSession(action.conversationId);
      return;
    case 'interrupt':
      await deps.ledger.updateRun(action.runId, {
        status: 'interrupted',
        reason: action.worktreePresent
          ? 'no daemon session at boot; the worktree is still on disk'
          : 'no daemon session at boot; the worktree is gone too',
        daemonSessionId: null,
      });
      return;
  }
}

/**
 * Reads both sides, plans, applies. Meant to run once per connection to
 * the daemon (`registerBootReconcile`), never on a timer: a periodic
 * reconcile would race the run lifecycle it is meant to repair.
 */
export async function reconcileRunsAtBoot(
  deps: ReconcileDeps,
): Promise<ReconcileReport> {
  const [sessions, workspaces, liveRuns] = await Promise.all([
    deps.daemon.listSessions(),
    deps.daemon.listWorkspaceRecords(),
    deps.ledger.listAllRuns({ status: [...LIVE_RUN_STATUSES] }),
  ]);
  const liveIds = new Set(liveRuns.map((run) => run.id));
  const otherRuns: ReconcileInput['otherRuns'] = {};
  for (const conversationId of Object.keys(sessions)) {
    if (
      conversationId.startsWith(RUN_ID_PREFIX) &&
      !liveIds.has(conversationId)
    ) {
      otherRuns[conversationId] = await deps.ledger.getRun(conversationId);
    }
  }

  const actions = planReconcile({ sessions, workspaces, liveRuns, otherRuns });
  const failures: ReconcileReport['failures'] = [];
  for (const action of actions) {
    try {
      await applyAction(deps, action);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ action, message });
      deps.logger.warn('engine: reconcile action failed', { action, message });
    }
  }
  const summary = actions.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return acc;
  }, {});
  deps.logger.info('engine: runs reconciled at boot', {
    ...summary,
    failures: failures.length,
  });
  return { actions, failures };
}
