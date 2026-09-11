import {
  DaemonApiError,
  type DaemonRunsApi,
  type DaemonWorkspaceRecord,
} from './daemonApi';
import type { AgentRun, LedgerClient } from './ledgerClient';
import {
  chooseBranchName,
  preferredBranchName,
  provisionWorktree,
  releaseWorktree,
  repositoryRecordId,
  shortRunId,
  worktreePathFor,
} from './worktrees';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-abc1234',
    projectId: 'proj-1',
    ticketId: 'wi-1',
    ownerMemberId: 'mem-1',
    agentId: null,
    entry: 'dispatched',
    providerId: 'claude',
    daemonWorkspaceId: null,
    daemonSessionId: null,
    worktreePath: null,
    branch: null,
    baseRef: null,
    prUrl: null,
    status: 'provisioning',
    blockedReason: null,
    errorKind: null,
    errorMessage: null,
    summary: null,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    retryOfRunId: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

function record(
  overrides: Partial<DaemonWorkspaceRecord> = {},
): DaemonWorkspaceRecord {
  return {
    id: 'run-abc1234',
    kind: 'worktree',
    path: '/private/userdata/engine/worktrees/run-abc1234',
    parentId: 'repo-x',
    observedStatus: 'present',
    creation: {
      branch: 'agent/ROAD-55',
      baseRef: 'main',
      requestedPath: '/userdata/engine/worktrees/run-abc1234',
    },
    lastCreateOutcome: { status: 'succeeded', at: 1 },
    ...overrides,
  };
}

function fakeDaemon(
  overrides: Partial<DaemonRunsApi> = {},
): jest.Mocked<DaemonRunsApi> {
  return {
    registerRepository: jest.fn(async (id, p) =>
      record({
        id,
        kind: 'repository',
        path: `/private${p}`,
        parentId: null,
        creation: null,
      }),
    ),
    createWorktree: jest.fn(async (req) =>
      record({
        id: req.workspaceId,
        path: `/private${req.path}`,
        creation: {
          branch: req.branch,
          baseRef: req.baseRef,
          requestedPath: req.path,
        },
      }),
    ),
    deleteWorktree: jest.fn(async () => {}),
    listLocalBranches: jest.fn(async () => ['main']),
    listWorkspaceRecords: jest.fn(async () => ({})),
    listSessions: jest.fn(async () => ({})),
    killSession: jest.fn(async () => {}),
    ...overrides,
  } as jest.Mocked<DaemonRunsApi>;
}

function fakeLedger(): jest.Mocked<LedgerClient> {
  return {
    createRun: jest.fn(),
    getRun: jest.fn(),
    listRuns: jest.fn(),
    listAllRuns: jest.fn(),
    updateRun: jest.fn(async (id, patch) =>
      run({ id, ...patch } as Partial<AgentRun>),
    ),
    appendEvent: jest.fn(async (runId, kind) => ({
      runId,
      seq: 2,
      kind,
      payload: {},
      at: '',
    })),
  } as unknown as jest.Mocked<LedgerClient>;
}

const logger = { info: jest.fn(), warn: jest.fn() };
const WORKTREES = '/userdata/engine/worktrees';

beforeEach(() => jest.clearAllMocks());

describe('naming', () => {
  it('agent/<TICKET> for a dispatched run, session/<short id> for an independent one', () => {
    expect(preferredBranchName(run(), 'ROAD-55')).toBe('agent/ROAD-55');
    expect(preferredBranchName(run({ entry: 'independent' }), null)).toBe(
      'session/abc1234',
    );
    // A dispatched run with no ticket identifier to hand still gets a valid name.
    expect(preferredBranchName(run(), null)).toBe('session/abc1234');
  });

  it('appends the short id when the preferred branch already exists, so a new run never starts from an old branch head', () => {
    expect(chooseBranchName(run(), 'ROAD-55', ['main'])).toBe('agent/ROAD-55');
    expect(chooseBranchName(run(), 'ROAD-55', ['main', 'agent/ROAD-55'])).toBe(
      'agent/ROAD-55-abc1234',
    );
    expect(
      chooseBranchName(run(), 'ROAD-55', [
        'agent/ROAD-55',
        'agent/ROAD-55-abc1234',
      ]),
    ).toBe('agent/ROAD-55-abc1234-2');
  });

  it('puts the worktree at <worktreesDir>/<run id> and keys the repository by a hash of its path', () => {
    expect(worktreePathFor(WORKTREES, 'run-abc1234')).toBe(
      '/userdata/engine/worktrees/run-abc1234',
    );
    expect(repositoryRecordId('/Users/me/proj')).toMatch(/^repo-[0-9a-f]{16}$/);
    expect(repositoryRecordId('/Users/me/proj')).toBe(
      repositoryRecordId('/Users/me/proj/'),
    );
    expect(repositoryRecordId('/Users/me/proj')).not.toBe(
      repositoryRecordId('/Users/me/other'),
    );
    expect(shortRunId('run-abc1234')).toBe('abc1234');
  });
});

describe('provisionWorktree', () => {
  it('registers the repo, picks a free branch, creates the worktree via the daemon and records the canonical path', async () => {
    const daemon = fakeDaemon();
    const ledger = fakeLedger();

    const result = await provisionWorktree(
      { daemon, ledger, worktreesDir: WORKTREES, logger },
      { run: run(), repoPath: '/Users/me/proj', ticketIdentifier: 'ROAD-55' },
    );

    expect(daemon.registerRepository).toHaveBeenCalledWith(
      repositoryRecordId('/Users/me/proj'),
      '/Users/me/proj',
    );
    // Branches are read from the repository record's own (canonical) path.
    expect(daemon.listLocalBranches).toHaveBeenCalledWith(
      '/private/Users/me/proj',
    );
    expect(daemon.createWorktree).toHaveBeenCalledWith({
      workspaceId: 'run-abc1234',
      repositoryId: repositoryRecordId('/Users/me/proj'),
      branch: 'agent/ROAD-55',
      baseRef: 'main',
      path: '/userdata/engine/worktrees/run-abc1234',
    });
    expect(result).toEqual({
      worktreePath: '/private/userdata/engine/worktrees/run-abc1234',
      branch: 'agent/ROAD-55',
      baseRef: 'main',
      daemonWorkspaceId: 'run-abc1234',
      repositoryId: repositoryRecordId('/Users/me/proj'),
    });
    expect(ledger.updateRun).toHaveBeenCalledWith('run-abc1234', {
      worktreePath: '/private/userdata/engine/worktrees/run-abc1234',
      branch: 'agent/ROAD-55',
      baseRef: 'main',
      daemonWorkspaceId: 'run-abc1234',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'worktree_created',
      expect.objectContaining({ branch: 'agent/ROAD-55' }),
    );
  });

  it('uses the run’s own base_ref when it has one, else the caller’s, else main', async () => {
    const daemon = fakeDaemon();
    const deps = {
      daemon,
      ledger: fakeLedger(),
      worktreesDir: WORKTREES,
      logger,
    };

    await provisionWorktree(deps, {
      run: run({ baseRef: 'develop' }),
      repoPath: '/r',
      ticketIdentifier: 'T-1',
    });
    await provisionWorktree(deps, {
      run: run({ id: 'run-second1' }),
      repoPath: '/r',
      ticketIdentifier: 'T-1',
      baseRef: 'release/1',
    });

    expect(daemon.createWorktree.mock.calls.map((c) => c[0].baseRef)).toEqual([
      'develop',
      'release/1',
    ]);
  });

  it('adopts the repository record the daemon already has for that path, whatever its id', async () => {
    const daemon = fakeDaemon({
      registerRepository: jest.fn(async () =>
        record({
          id: 'repo-existing',
          kind: 'repository',
          path: '/private/r',
          parentId: null,
          creation: null,
        }),
      ),
    });

    await provisionWorktree(
      { daemon, ledger: fakeLedger(), worktreesDir: WORKTREES, logger },
      { run: run(), repoPath: '/r', ticketIdentifier: 'T-1' },
    );

    expect(daemon.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: 'repo-existing' }),
    );
  });

  it('retries once with a suffixed branch when add-worktree fails because the branch is checked out elsewhere', async () => {
    const stageFailed = new DaemonApiError(
      'workspaceRegistry.createWorktree',
      {
        type: 'stage-failed',
        stage: 'add-worktree',
        message: 'git worktree add … failed (exit 128)',
      },
      'stage-failed: add-worktree',
    );
    const daemon = fakeDaemon();
    daemon.createWorktree
      .mockRejectedValueOnce(stageFailed)
      .mockImplementationOnce(async (req) =>
        record({
          path: `/private${req.path}`,
          creation: {
            branch: req.branch,
            baseRef: req.baseRef,
            requestedPath: req.path,
          },
        }),
      );

    const result = await provisionWorktree(
      { daemon, ledger: fakeLedger(), worktreesDir: WORKTREES, logger },
      { run: run(), repoPath: '/r', ticketIdentifier: 'ROAD-55' },
    );

    expect(daemon.createWorktree).toHaveBeenCalledTimes(2);
    expect(daemon.createWorktree.mock.calls[1][0].branch).toBe(
      'agent/ROAD-55-abc1234',
    );
    expect(result.branch).toBe('agent/ROAD-55-abc1234');
    // The failed record is removed first: the daemon refuses a replay of
    // the same id with a different branch (immutable-field-mismatch).
    expect(daemon.deleteWorktree).toHaveBeenCalledWith('run-abc1234', {
      deleteBranch: false,
    });
    const order = [
      ...daemon.createWorktree.mock.invocationCallOrder,
      ...daemon.deleteWorktree.mock.invocationCallOrder,
    ].sort((a, b) => a - b);
    expect(order[1]).toBe(daemon.deleteWorktree.mock.invocationCallOrder[0]);
  });

  it('does not retry any other failure, and writes the failure to the ledger before rethrowing', async () => {
    const failure = new DaemonApiError(
      'workspaceRegistry.createWorktree',
      {
        type: 'stage-failed',
        stage: 'resolve-base',
        message: 'fatal: invalid reference: nope',
      },
      'stage-failed: resolve-base: fatal: invalid reference: nope',
    );
    const daemon = fakeDaemon({
      createWorktree: jest.fn().mockRejectedValue(failure),
    });
    const ledger = fakeLedger();

    await expect(
      provisionWorktree(
        { daemon, ledger, worktreesDir: WORKTREES, logger },
        {
          run: run(),
          repoPath: '/r',
          ticketIdentifier: 'ROAD-55',
          baseRef: 'nope',
        },
      ),
    ).rejects.toBe(failure);

    expect(daemon.createWorktree).toHaveBeenCalledTimes(1);
    expect(ledger.updateRun).toHaveBeenCalledWith('run-abc1234', {
      errorKind: 'provision',
      errorMessage:
        'stage-failed: resolve-base: fatal: invalid reference: nope',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith('run-abc1234', 'error', {
      stage: 'worktree',
      message: 'stage-failed: resolve-base: fatal: invalid reference: nope',
    });
    // No status move: the caller owns the run's status.
    expect(ledger.updateRun).not.toHaveBeenCalledWith(
      'run-abc1234',
      expect.objectContaining({ status: expect.anything() }),
    );
  });

  it('never claims a worktree the daemon did not create: no worktree_created event on failure', async () => {
    const daemon = fakeDaemon({
      registerRepository: jest
        .fn()
        .mockRejectedValue(new Error('path-not-found: /r')),
    });
    const ledger = fakeLedger();

    await expect(
      provisionWorktree(
        { daemon, ledger, worktreesDir: WORKTREES, logger },
        { run: run(), repoPath: '/r', ticketIdentifier: null },
      ),
    ).rejects.toThrow('path-not-found');

    expect(daemon.createWorktree).not.toHaveBeenCalled();
    expect(ledger.appendEvent).not.toHaveBeenCalledWith(
      'run-abc1234',
      'worktree_created',
      expect.anything(),
    );
  });
});

describe('releaseWorktree', () => {
  it('merged: removes the worktree and its branch; abandoned: keeps the branch', async () => {
    const daemon = fakeDaemon();
    const ledger = fakeLedger();
    const deps = { daemon, ledger, worktreesDir: WORKTREES, logger };
    const r = run({
      daemonWorkspaceId: 'run-abc1234',
      worktreePath: '/private/wt',
      branch: 'agent/ROAD-55',
    });

    await releaseWorktree(deps, r, 'merged');
    await releaseWorktree(deps, r, 'abandoned');

    expect(daemon.deleteWorktree.mock.calls).toEqual([
      ['run-abc1234', { deleteBranch: true }],
      ['run-abc1234', { deleteBranch: false }],
    ]);
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'worktree_removed',
      {
        path: '/private/wt',
        branch: 'agent/ROAD-55',
        reason: 'merged',
        branchDeleted: true,
      },
    );
  });

  it('falls back to the run id as the daemon record id when the ledger never recorded one', async () => {
    const daemon = fakeDaemon();

    await releaseWorktree(
      { daemon, ledger: fakeLedger(), worktreesDir: WORKTREES, logger },
      run(),
      'abandoned',
    );

    expect(daemon.deleteWorktree).toHaveBeenCalledWith('run-abc1234', {
      deleteBranch: false,
    });
  });
});
