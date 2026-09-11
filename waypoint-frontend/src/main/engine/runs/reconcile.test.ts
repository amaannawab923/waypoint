import type { DaemonRunsApi } from './daemonApi';
import type { AgentRun, AgentRunStatus, LedgerClient } from './ledgerClient';
import {
  planReconcile,
  reconcileRunsAtBoot,
  type ReconcileInput,
} from './reconcile';

const session = (conversationId: string) => ({ conversationId });
const run = (id: string, status: AgentRunStatus) => ({ id, status });

function plan(partial: Partial<ReconcileInput>) {
  return planReconcile({
    sessions: {},
    workspaces: {},
    liveRuns: [],
    otherRuns: {},
    ...partial,
  });
}

describe('planReconcile', () => {
  it('re-attaches a run the daemon and the ledger both have live', () => {
    expect(
      plan({
        sessions: { 'run-a': session('run-a') },
        liveRuns: [run('run-a', 'running')],
      }),
    ).toEqual([{ kind: 'reattach', runId: 'run-a' }]);
  });

  it('adopts an interrupted run whose session the daemon brought back', () => {
    expect(
      plan({
        sessions: { 'run-a': session('run-a') },
        otherRuns: { 'run-a': run('run-a', 'interrupted') },
      }),
    ).toEqual([{ kind: 'adopt', runId: 'run-a' }]);
  });

  it('kills a session for a run the ledger already finished', () => {
    for (const status of [
      'done',
      'failed',
      'cancelled',
      'needs-review',
      'queued',
    ] as const) {
      expect(
        plan({
          sessions: { 'run-a': session('run-a') },
          otherRuns: { 'run-a': run('run-a', status) },
        }),
      ).toEqual([{ kind: 'kill-stale', runId: 'run-a', status }]);
    }
  });

  it('kills an orphan named like ours with no ledger row, and leaves a conversation that is not ours alone', () => {
    expect(
      plan({
        sessions: {
          'run-ghost': session('run-ghost'),
          'conv-emdash1': session('conv-emdash1'),
        },
        otherRuns: { 'run-ghost': null },
      }),
    ).toEqual([
      { kind: 'leave', conversationId: 'conv-emdash1' },
      { kind: 'kill-orphan', conversationId: 'run-ghost' },
    ]);
  });

  it('interrupts every live run the daemon has no session for, noting whether the worktree survived', () => {
    expect(
      plan({
        liveRuns: [
          run('run-b', 'blocked'),
          run('run-a', 'provisioning'),
          run('run-c', 'finishing'),
        ],
        workspaces: {
          'run-a': { id: 'run-a', observedStatus: 'present' },
          'run-b': { id: 'run-b', observedStatus: 'missing' },
        },
      }),
    ).toEqual([
      {
        kind: 'interrupt',
        runId: 'run-a',
        status: 'provisioning',
        worktreePresent: true,
      },
      {
        kind: 'interrupt',
        runId: 'run-b',
        status: 'blocked',
        worktreePresent: false,
      },
      {
        kind: 'interrupt',
        runId: 'run-c',
        status: 'finishing',
        worktreePresent: false,
      },
    ]);
  });

  it('handles a mixed boot in one deterministic plan', () => {
    const actions = plan({
      sessions: {
        'run-live': session('run-live'),
        'run-back': session('run-back'),
        'run-old': session('run-old'),
        'run-x': session('run-x'),
      },
      liveRuns: [run('run-live', 'running'), run('run-lost', 'running')],
      otherRuns: {
        'run-back': run('run-back', 'interrupted'),
        'run-old': run('run-old', 'done'),
        'run-x': null,
      },
      workspaces: { 'run-lost': { id: 'run-lost', observedStatus: 'present' } },
    });

    expect(actions).toEqual([
      { kind: 'adopt', runId: 'run-back' },
      { kind: 'reattach', runId: 'run-live' },
      { kind: 'kill-stale', runId: 'run-old', status: 'done' },
      { kind: 'kill-orphan', conversationId: 'run-x' },
      {
        kind: 'interrupt',
        runId: 'run-lost',
        status: 'running',
        worktreePresent: true,
      },
    ]);
  });

  it('is a no-op plan when both sides are empty', () => {
    expect(plan({})).toEqual([]);
  });
});

function fakeDaemon(
  overrides: Partial<DaemonRunsApi> = {},
): jest.Mocked<DaemonRunsApi> {
  return {
    registerRepository: jest.fn(),
    createWorktree: jest.fn(),
    deleteWorktree: jest.fn(),
    listLocalBranches: jest.fn(),
    listWorkspaceRecords: jest.fn(async () => ({})),
    listSessions: jest.fn(async () => ({})),
    killSession: jest.fn(async () => {}),
    ...overrides,
  } as jest.Mocked<DaemonRunsApi>;
}

function fakeLedger(
  rows: Record<string, Partial<AgentRun>> = {},
): jest.Mocked<LedgerClient> {
  return {
    createRun: jest.fn(),
    getRun: jest.fn(async (id: string) =>
      rows[id] ? ({ id, ...rows[id] } as AgentRun) : null,
    ),
    listRuns: jest.fn(),
    listAllRuns: jest.fn(async (q) =>
      Object.entries(rows)
        .filter(([, r]) => q.status?.includes(r.status!))
        .map(([id, r]) => ({ id, ...r }) as AgentRun),
    ),
    updateRun: jest.fn(async (id, patch) => ({ id, ...patch }) as AgentRun),
    appendEvent: jest.fn(async (runId, kind) => ({
      runId,
      seq: 0,
      kind,
      payload: {},
      at: '',
    })),
  } as unknown as jest.Mocked<LedgerClient>;
}

const logger = { info: jest.fn(), warn: jest.fn() };

beforeEach(() => jest.clearAllMocks());

describe('reconcileRunsAtBoot', () => {
  it('reads sessions, workspaces and the live runs, looks up the not-live rows the daemon names, and applies the plan', async () => {
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => ({
        'run-live': { conversationId: 'run-live' } as never,
        'run-back': { conversationId: 'run-back' } as never,
        'run-old': { conversationId: 'run-old' } as never,
        'run-x': { conversationId: 'run-x' } as never,
        'conv-other': { conversationId: 'conv-other' } as never,
      })),
      listWorkspaceRecords: jest.fn(async () => ({
        'run-lost': { id: 'run-lost', observedStatus: 'present' } as never,
      })),
    });
    const ledger = fakeLedger({
      'run-live': { status: 'running' },
      'run-lost': { status: 'blocked' },
      'run-back': { status: 'interrupted' },
      'run-old': { status: 'cancelled' },
    });

    const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

    expect(ledger.listAllRuns).toHaveBeenCalledWith({
      status: ['provisioning', 'running', 'blocked', 'finishing'],
    });
    // Only the daemon's run-named sessions that are not live get looked up.
    expect(ledger.getRun.mock.calls.map((c) => c[0]).sort()).toEqual([
      'run-back',
      'run-old',
      'run-x',
    ]);
    expect(report.failures).toEqual([]);
    expect(report.actions.map((a) => a.kind)).toEqual([
      'leave',
      'adopt',
      'reattach',
      'kill-stale',
      'kill-orphan',
      'interrupt',
    ]);

    // reattach: an event, no status change.
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-live',
      'session_resumed',
      expect.objectContaining({ at: 'boot' }),
    );
    expect(ledger.updateRun).not.toHaveBeenCalledWith(
      'run-live',
      expect.anything(),
    );
    // adopt: interrupted → running, with the session id recorded.
    expect(ledger.updateRun).toHaveBeenCalledWith(
      'run-back',
      expect.objectContaining({
        status: 'running',
        daemonSessionId: 'run-back',
      }),
    );
    // kill-stale and kill-orphan both kill; only the stale one has a row to note it on.
    expect(daemon.killSession.mock.calls.map((c) => c[0]).sort()).toEqual([
      'run-old',
      'run-x',
    ]);
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-old',
      'session_ended',
      expect.objectContaining({ note: expect.stringContaining('cancelled') }),
    );
    // interrupt: the reason says the worktree survived.
    expect(ledger.updateRun).toHaveBeenCalledWith('run-lost', {
      status: 'interrupted',
      reason: 'no daemon session at boot; the worktree is still on disk',
      daemonSessionId: null,
    });
    // leave: nothing at all for a conversation that is not ours.
    expect(daemon.killSession).not.toHaveBeenCalledWith('conv-other');
  });

  it('isolates a failing action: the rest of the plan still runs and the failure is reported', async () => {
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => ({
        'run-x': { conversationId: 'run-x' } as never,
      })),
      killSession: jest.fn(async () => {
        throw new Error('acp.kill: DISCONNECTED');
      }),
    });
    const ledger = fakeLedger({ 'run-lost': { status: 'running' } });

    const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

    expect(report.failures).toEqual([
      {
        action: { kind: 'kill-orphan', conversationId: 'run-x' },
        message: 'acp.kill: DISCONNECTED',
      },
    ]);
    expect(ledger.updateRun).toHaveBeenCalledWith(
      'run-lost',
      expect.objectContaining({ status: 'interrupted' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'engine: reconcile action failed',
      expect.objectContaining({ message: 'acp.kill: DISCONNECTED' }),
    );
  });

  it('does nothing when both sides are empty, and says so once', async () => {
    const report = await reconcileRunsAtBoot({
      daemon: fakeDaemon(),
      ledger: fakeLedger(),
      logger,
    });

    expect(report).toEqual({ actions: [], failures: [] });
    expect(logger.info).toHaveBeenCalledWith(
      'engine: runs reconciled at boot',
      { failures: 0 },
    );
  });
});
