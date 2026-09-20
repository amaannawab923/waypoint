import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonRunsApi, DaemonSessionSummary } from './daemonApi';
import type { AgentRun, AgentRunStatus, LedgerClient } from './ledgerClient';
import {
  LIVE_RUN_STATUSES,
  planReconcile,
  reconcileRunsAtBoot,
  type ReconcileInput,
} from './reconcile';
import { withRunLock } from './runLock';

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

// The set of statuses reconcile expects a daemon session for is defined
// twice — here and in waypoint-backend/src/services/runStatusMachine.ts —
// across a repo boundary with no shared package. A backend that adds a
// live status the frontend copy lacks would leave runs in it "believed
// live" forever after a crash (review round 2). This reads the backend's
// source text and holds the two to each other.
describe('LIVE_RUN_STATUSES', () => {
  it('matches the backend’s runStatusMachine.ts exactly', () => {
    const backend = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        '..',
        'waypoint-backend',
        'src',
        'services',
        'runStatusMachine.ts',
      ),
      'utf8',
    );
    const match = backend.match(
      /LIVE_RUN_STATUSES[^=]*=\s*new Set\(\[([^\]]*)\]\)/,
    );
    expect(match).not.toBeNull();
    const backendList = [...match![1].matchAll(/'([a-z-]+)'/g)].map(
      (m) => m[1],
    );
    expect([...LIVE_RUN_STATUSES]).toEqual(backendList);
  });
});

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

  it("kills a session only for a failed or cancelled run — a stale one; a finished run's session is reattached, silently (never-lock)", () => {
    for (const status of ['failed', 'cancelled'] as const) {
      expect(
        plan({
          sessions: { 'run-a': session('run-a') },
          otherRuns: { 'run-a': run('run-a', status) },
        }),
      ).toEqual([{ kind: 'kill-stale', runId: 'run-a', status }]);
    }
    // done/needs-review keep their session alive since finalize no longer
    // kills it; a boot reattaches without an event, so no marker appears.
    for (const status of ['done', 'needs-review'] as const) {
      expect(
        plan({
          sessions: { 'run-a': session('run-a') },
          otherRuns: { 'run-a': run('run-a', status) },
        }),
      ).toEqual([{ kind: 'reattach', runId: 'run-a', finished: true }]);
    }
  });

  it('leaves — and only reports — a session for a run that is neither live nor ended (review round 2)', () => {
    for (const status of ['queued'] as const) {
      expect(
        plan({
          sessions: { 'run-a': session('run-a') },
          otherRuns: { 'run-a': run('run-a', status) },
        }),
      ).toEqual([{ kind: 'leave-unexpected', runId: 'run-a', status }]);
    }
  });

  it('reports an orphan named like ours with no ledger row without killing it, and does not even report a conversation that is not ours', () => {
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
      { kind: 'orphan', conversationId: 'run-ghost' },
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
        'run-old': run('run-old', 'cancelled'),
        'run-x': null,
      },
      workspaces: { 'run-lost': { id: 'run-lost', observedStatus: 'present' } },
    });

    expect(actions).toEqual([
      { kind: 'adopt', runId: 'run-back' },
      { kind: 'reattach', runId: 'run-live' },
      { kind: 'kill-stale', runId: 'run-old', status: 'cancelled' },
      { kind: 'orphan', conversationId: 'run-x' },
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
    getHistory: jest.fn(async () => []),
    sendPrompt: jest.fn(async () => {}),
    ...overrides,
  } as jest.Mocked<DaemonRunsApi>;
}

function fakeLedger(
  rows: Record<string, Partial<AgentRun>> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test double's own record shape, not the real PendingPrompt
  pending: Map<string, any> = new Map(),
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
    listPendingPrompts: jest.fn(async (runId: string) =>
      [...pending.values()]
        .filter((p) => p.runId === runId)
        .sort((a, b) => a.seq - b.seq),
    ),
    updatePendingPrompt: jest.fn(
      async (_runId: string, pendingId: string, patch) => {
        const current = pending.get(pendingId);
        if (!current) throw new Error(`no pending prompt ${pendingId}`);
        const next = { ...current, ...patch };
        pending.set(pendingId, next);
        return next;
      },
    ),
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
    // The daemon's run-named sessions that are not live get looked up
    // building `otherRuns`; 'run-old' again inside kill-stale's own
    // re-read under the run lock (ROAD-XXX), since a resume could have
    // landed between the plan and this action's turn; 'run-back' and
    // 'run-live' again for their outbox drain (never-lock, design
    // §2.4 trigger 3 — reattach/adopt's own re-read before draining);
    // 'run-back' a third time and 'run-lost' once more for adopt's and
    // interrupt's own re-reads under the run lock (review round 4 —
    // the same guard kill-stale has).
    expect(ledger.getRun.mock.calls.map((c) => c[0]).sort()).toEqual([
      'run-back',
      'run-back',
      'run-back',
      'run-live',
      'run-lost',
      'run-old',
      'run-old',
      'run-x',
    ]);
    expect(report.failures).toEqual([]);
    expect(report.actions.map((a) => a.kind)).toEqual([
      'leave',
      'adopt',
      'reattach',
      'kill-stale',
      'orphan',
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
    // Only the stale session (a run the ledger ended) is killed; the orphan
    // is reported and left (review round 2).
    expect(daemon.killSession.mock.calls.map((c) => c[0])).toEqual(['run-old']);
    expect(logger.warn).toHaveBeenCalledWith(
      'engine: daemon session with no ledger row — left running',
      { conversationId: 'run-x' },
    );
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

  // ROAD-XXX: resume dead sessions — a resume can land between this
  // action's plan and its turn to apply, since bootReconcile runs on
  // every daemon (re)connect, not just at launch.
  it('kill-stale skips, without killing anything, when a resume already holds the run lock', async () => {
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => ({
        'run-old': { conversationId: 'run-old' } as never,
      })),
    });
    const ledger = fakeLedger({ 'run-old': { status: 'failed' } });

    let releaseResume: (() => void) | null = null;
    const resuming = withRunLock('run-old', async () => {
      await new Promise<void>((resolve) => {
        releaseResume = resolve;
      });
    });

    const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

    expect(report.actions.map((a) => a.kind)).toEqual(['kill-stale']);
    expect(report.failures).toEqual([]);
    expect(daemon.killSession).not.toHaveBeenCalled();
    expect(ledger.appendEvent).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'engine: kill-stale skipped — a resume is in flight for this run',
      { runId: 'run-old' },
    );

    releaseResume!();
    await resuming;
  });

  it('kill-stale re-reads under the lock and skips when the run was revived by the time its turn comes up', async () => {
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => ({
        'run-old': { conversationId: 'run-old' } as never,
      })),
    });
    const ledger = fakeLedger({ 'run-old': { status: 'failed' } });
    let getRunCalls = 0;
    (ledger.getRun as jest.Mock).mockImplementation(async (id: string) => {
      if (id !== 'run-old') return null;
      getRunCalls += 1;
      // The plan-building read (via listAllRuns/otherRuns) sees `failed`;
      // by the time kill-stale re-reads under the lock, a resume has
      // already revived the run to `provisioning`.
      return getRunCalls === 1
        ? ({ id, status: 'failed' } as AgentRun)
        : ({ id, status: 'provisioning' } as AgentRun);
    });

    const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

    expect(report.actions.map((a) => a.kind)).toEqual(['kill-stale']);
    expect(report.failures).toEqual([]);
    expect(daemon.killSession).not.toHaveBeenCalled();
    expect(ledger.appendEvent).not.toHaveBeenCalled();
  });

  // Review round 4: kill-stale alone had the guard above; interrupt and
  // adopt wrote straight off the plan's snapshot. The window is the
  // same one — a send or resume landing between plan and apply.
  describe('interrupt and adopt take the same guard kill-stale does', () => {
    it('interrupt skips while a resume holds the run lock', async () => {
      const daemon = fakeDaemon({ listSessions: jest.fn(async () => ({})) });
      const ledger = fakeLedger({ 'run-lost': { status: 'running' } });
      let release: (() => void) | null = null;
      const resuming = withRunLock('run-lost', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });

      const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

      expect(report.actions.map((a) => a.kind)).toEqual(['interrupt']);
      expect(report.failures).toEqual([]);
      expect(ledger.updateRun).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'engine: interrupt skipped — a resume is in flight for this run',
        { runId: 'run-lost' },
      );
      release!();
      await resuming;
    });

    it('interrupt asks the daemon again under the lock and leaves a run someone revived meanwhile — the status alone would not have said so', async () => {
      // A send on a live-status run the daemon lost starts the session
      // again and leaves the status `running` (sendPrompt.ts): the plan's
      // read and the re-read agree on the status, so only the daemon can
      // tell that the precondition is gone.
      let asked = 0;
      const daemon = fakeDaemon({
        listSessions: jest.fn(
          async (): Promise<Record<string, DaemonSessionSummary>> => {
            asked += 1;
            return asked === 1
              ? {}
              : { 'run-lost': { conversationId: 'run-lost' } as never };
          },
        ),
      });
      const ledger = fakeLedger({ 'run-lost': { status: 'running' } });

      const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

      expect(report.actions.map((a) => a.kind)).toEqual(['interrupt']);
      expect(report.failures).toEqual([]);
      expect(ledger.updateRun).not.toHaveBeenCalled();
    });

    it('adopt skips while a resume holds the run lock, and re-reads to skip a run already revived', async () => {
      const daemon = fakeDaemon({
        listSessions: jest.fn(async () => ({
          'run-back': { conversationId: 'run-back' } as never,
        })),
      });
      const held = fakeLedger({ 'run-back': { status: 'interrupted' } });
      let release: (() => void) | null = null;
      const resuming = withRunLock('run-back', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const first = await reconcileRunsAtBoot({ daemon, ledger: held, logger });
      expect(first.actions.map((a) => a.kind)).toEqual(['adopt']);
      expect(held.updateRun).not.toHaveBeenCalled();
      expect(held.appendEvent).not.toHaveBeenCalled();
      release!();
      await resuming;

      const revived = fakeLedger({ 'run-back': { status: 'interrupted' } });
      let reads = 0;
      (revived.getRun as jest.Mock).mockImplementation(async (id: string) => {
        if (id !== 'run-back') return null;
        reads += 1;
        return reads === 1
          ? ({ id, status: 'interrupted' } as AgentRun)
          : ({ id, status: 'provisioning' } as AgentRun);
      });
      const second = await reconcileRunsAtBoot({
        daemon,
        ledger: revived,
        logger,
      });
      expect(second.actions.map((a) => a.kind)).toEqual(['adopt']);
      expect(revived.updateRun).not.toHaveBeenCalled();
      expect(revived.appendEvent).not.toHaveBeenCalled();
    });
  });

  // Never-lock (design §2.4 trigger 3 / §7.2): a reattach or an adopt
  // means a live session exists now — its outbox, if it has one, was
  // never anyone's job to drain until this (found in review: the
  // trigger was documented, never wired up).
  describe('the outbox drains at boot, on reattach and on adopt', () => {
    it('delivers a queued row on a run the daemon still has (reattach)', async () => {
      const pending = new Map([
        [
          'pp-1',
          {
            id: 'pp-1',
            runId: 'run-live',
            seq: 1,
            state: 'queued',
            text: 'while you were away',
            byMemberId: 'mem-1',
            reason: 'starting',
            autoAttempts: 0,
            lastError: null,
            claimedAt: null,
            resolvedAt: null,
            createdAt: '2026-09-20T00:00:00.000Z',
          },
        ],
      ]);
      const daemon = fakeDaemon({
        listSessions: jest.fn(async () => ({
          'run-live': { conversationId: 'run-live' } as never,
        })),
      });
      const ledger = fakeLedger(
        { 'run-live': { status: 'running', ownerMemberId: 'mem-1' } },
        pending,
      );

      const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

      expect(report.actions.map((a) => a.kind)).toEqual(['reattach']);
      expect(report.failures).toEqual([]);
      expect(daemon.sendPrompt).toHaveBeenCalledWith(
        'run-live',
        'while you were away',
        undefined,
      );
      expect(pending.get('pp-1')?.state).toBe('delivered');
    });

    it('delivers a queued row on a run the daemon resumed while Waypoint was away (adopt)', async () => {
      const pending = new Map([
        [
          'pp-1',
          {
            id: 'pp-1',
            runId: 'run-back',
            seq: 1,
            state: 'queued',
            text: 'catch me up',
            byMemberId: 'mem-1',
            reason: 'starting',
            autoAttempts: 0,
            lastError: null,
            claimedAt: null,
            resolvedAt: null,
            createdAt: '2026-09-20T00:00:00.000Z',
          },
        ],
      ]);
      const daemon = fakeDaemon({
        listSessions: jest.fn(async () => ({
          'run-back': { conversationId: 'run-back' } as never,
        })),
      });
      const ledger = fakeLedger(
        { 'run-back': { status: 'interrupted', ownerMemberId: 'mem-1' } },
        pending,
      );

      const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

      expect(report.actions.map((a) => a.kind)).toEqual(['adopt']);
      expect(report.failures).toEqual([]);
      expect(daemon.sendPrompt).toHaveBeenCalledWith(
        'run-back',
        'catch me up',
        undefined,
      );
      expect(pending.get('pp-1')?.state).toBe('delivered');
    });

    it('does not stall the rest of reconcile, and does not mark the action failed, when the run lock is already held', async () => {
      const pending = new Map([
        [
          'pp-1',
          {
            id: 'pp-1',
            runId: 'run-live',
            seq: 1,
            state: 'queued',
            text: 'hello',
            byMemberId: 'mem-1',
            reason: 'starting',
            autoAttempts: 0,
            lastError: null,
            claimedAt: null,
            resolvedAt: null,
            createdAt: '2026-09-20T00:00:00.000Z',
          },
        ],
      ]);
      const daemon = fakeDaemon({
        listSessions: jest.fn(async () => ({
          'run-live': { conversationId: 'run-live' } as never,
        })),
      });
      const ledger = fakeLedger({ 'run-live': { status: 'running' } }, pending);

      let releaseSend: (() => void) | null = null;
      const sending = withRunLock('run-live', async () => {
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
      });

      const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

      expect(report.actions.map((a) => a.kind)).toEqual(['reattach']);
      expect(report.failures).toEqual([]);
      expect(daemon.sendPrompt).not.toHaveBeenCalled();
      expect(pending.get('pp-1')?.state).toBe('queued');
      expect(logger.info).toHaveBeenCalledWith(
        'engine: boot outbox drain skipped — the run lock is held',
        { runId: 'run-live' },
      );

      releaseSend!();
      await sending;
    });
  });

  it('isolates a failing action: the rest of the plan still runs and the failure is reported', async () => {
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => ({
        'run-old': { conversationId: 'run-old' } as never,
      })),
      killSession: jest.fn(async () => {
        throw new Error('acp.kill: DISCONNECTED');
      }),
    });
    const ledger = fakeLedger({
      'run-lost': { status: 'running' },
      'run-old': { status: 'cancelled' },
    });

    const report = await reconcileRunsAtBoot({ daemon, ledger, logger });

    expect(report.failures).toEqual([
      {
        action: { kind: 'kill-stale', runId: 'run-old', status: 'cancelled' },
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
