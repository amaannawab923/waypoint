import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DaemonRunsApi } from './daemonApi';
import type { AgentRun, LedgerClient } from './ledgerClient';
import type { StartRunDeps } from './startRun';
import { clearWarmed, takeWarmed, warmRun } from './warm';

// Start on open (never-lock, design §2.5): the daemon only, never the
// ledger. Merely opening a finished run must change nothing about it.

let worktreesDir: string;
beforeAll(() => {
  worktreesDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wp-warm-')),
  );
});
afterAll(() => fs.rmSync(worktreesDir, { recursive: true, force: true }));
beforeEach(() => clearWarmed());

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const worktreePath = path.join(worktreesDir, 'run-abc1234');
  fs.mkdirSync(worktreePath, { recursive: true });
  return {
    id: 'run-abc1234',
    projectId: 'proj-1',
    ticketId: null,
    ownerMemberId: 'mem-1',
    agentId: null,
    entry: 'independent',
    providerId: 'claude',
    title: null,
    isolation: 'worktree',
    cwd: null,
    autoApprove: false,
    modeId: null,
    intent: null,
    copilotConversationId: null,
    daemonWorkspaceId: null,
    daemonSessionId: null,
    providerSessionId: 'sess-old',
    worktreePath,
    branch: 'session/abc1234',
    baseRef: 'main',
    prUrl: null,
    status: 'done',
    blockedReason: null,
    errorKind: null,
    errorMessage: null,
    summary: null,
    verdict: null,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    retryOfRunId: null,
    reopenCount: 0,
    lastReopenedAt: null,
    finalizeCount: 0,
    finalizedHeadSha: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

function depsWith(
  row: AgentRun,
  daemon: DaemonRunsApi | null,
  extra: Partial<StartRunDeps> = {},
) {
  const ledger = {
    getRun: jest.fn(async () => row),
    updateRun: jest.fn(),
    reopenRun: jest.fn(),
    appendEvent: jest.fn(),
  } as unknown as jest.Mocked<LedgerClient>;
  const deps: StartRunDeps = {
    ledger,
    daemon: () => daemon,
    worktreesDir,
    git: jest.fn(async () => ({ stdout: '', code: 0 })),
    assertWorktreeGitDir: jest.fn(async () => {}),
    folders: {
      registry: { resolve: jest.fn(), mint: jest.fn() } as never,
      recentsFile: path.join(worktreesDir, 'r.json'),
      listProjects: jest.fn(async () => []),
    },
    notify: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn() },
    ...extra,
  };
  return {
    ...deps,
    ledger,
    notify: deps.notify as jest.Mock,
    logger: deps.logger as { info: jest.Mock; warn: jest.Mock },
  };
}

function daemonWith(over: Partial<Record<keyof DaemonRunsApi, unknown>> = {}) {
  return {
    listSessions: jest.fn(async () => ({})),
    createConversation: jest.fn(async () => ({ mismatch: [] })),
    startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    ...over,
  } as unknown as jest.Mocked<DaemonRunsApi>;
}

describe('warmRun', () => {
  it('loads the session for a finished run whose daemon session is gone — and touches nothing else', async () => {
    const daemon = daemonWith();
    const deps = depsWith(run(), daemon);
    await expect(warmRun(deps, 'run-abc1234')).resolves.toEqual({
      kind: 'warmed',
      loaded: true,
    });
    expect(daemon.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'run-abc1234',
        sessionId: 'sess-old',
        cwd: path.join(worktreesDir, 'run-abc1234'),
      }),
    );
    expect(deps.ledger.updateRun).not.toHaveBeenCalled();
    expect(deps.ledger.reopenRun).not.toHaveBeenCalled();
    expect(deps.ledger.appendEvent).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    // What it learned waits for the first send, once.
    expect(takeWarmed('run-abc1234')).toEqual({
      sessionId: 'sess-old',
      loaded: true,
    });
    expect(takeWarmed('run-abc1234')).toBeNull();
  });

  it('registers the run in the daemon’s conversation index before the spawn, and still spawns when that fails', async () => {
    const daemon = daemonWith();
    await warmRun(depsWith(run(), daemon), 'run-abc1234');
    expect(daemon.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'run-abc1234',
        cwd: path.join(worktreesDir, 'run-abc1234'),
      }),
    );
    expect(daemon.createConversation.mock.invocationCallOrder[0]).toBeLessThan(
      daemon.startSession.mock.invocationCallOrder[0],
    );

    // Consume what the first warm remembered, so the second is a real spawn.
    takeWarmed('run-abc1234');
    const refusing = daemonWith({
      createConversation: jest.fn(async () => {
        throw new Error('index down');
      }),
    });
    const deps = depsWith(run(), refusing);
    await expect(warmRun(deps, 'run-abc1234')).resolves.toEqual({
      kind: 'warmed',
      loaded: true,
    });
    expect(refusing.startSession).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'engine: conversation registration failed',
      expect.objectContaining({ runId: 'run-abc1234', message: 'index down' }),
    );
  });

  it('remembers replaced-by-new when the provider started a fresh session', async () => {
    const daemon = daemonWith({
      startSession: jest.fn(async () => ({ sessionId: 'sess-fresh' })),
    });
    await expect(
      warmRun(depsWith(run(), daemon), 'run-abc1234'),
    ).resolves.toEqual({ kind: 'warmed', loaded: false });
    expect(takeWarmed('run-abc1234')).toEqual({
      sessionId: 'sess-fresh',
      loaded: false,
    });
  });

  it.each(['running', 'queued', 'provisioning'] as const)(
    'is already-live for a %s run',
    async (status) => {
      const daemon = daemonWith();
      await expect(
        warmRun(depsWith(run({ status }), daemon), 'run-abc1234'),
      ).resolves.toEqual({ kind: 'already-live' });
      expect(daemon.startSession).not.toHaveBeenCalled();
    },
  );

  it('is already-live when the daemon still has the session, or a warm-up already happened', async () => {
    const daemon = daemonWith({
      listSessions: jest.fn(async () => ({ 'run-abc1234': {} })),
    });
    await expect(
      warmRun(depsWith(run(), daemon), 'run-abc1234'),
    ).resolves.toEqual({ kind: 'already-live' });
    const daemon2 = daemonWith();
    const deps = depsWith(run(), daemon2);
    await warmRun(deps, 'run-abc1234');
    await expect(warmRun(deps, 'run-abc1234')).resolves.toEqual({
      kind: 'already-live',
    });
    expect(daemon2.startSession).toHaveBeenCalledTimes(1);
  });

  it('skips a worktree it would have to recreate (that writes the ledger — the send path’s job) and a run with no cwd', async () => {
    const daemon = daemonWith();
    await expect(
      warmRun(
        depsWith(
          run({ worktreePath: path.join(worktreesDir, 'gone'), cwd: null }),
          daemon,
        ),
        'run-abc1234',
      ),
    ).resolves.toEqual({ kind: 'skipped', why: 'worktree-unusable' });
    await expect(
      warmRun(
        depsWith(run({ worktreePath: null, cwd: null }), daemon),
        'run-abc1234',
      ),
    ).resolves.toEqual({ kind: 'skipped', why: 'no-cwd' });
    const badGit = jest.fn(async () => {
      throw new Error('not a linked worktree');
    });
    await expect(
      warmRun(
        depsWith(run(), daemon, { assertWorktreeGitDir: badGit }),
        'run-abc1234',
      ),
    ).resolves.toEqual({ kind: 'skipped', why: 'worktree-unusable' });
    expect(daemon.startSession).not.toHaveBeenCalled();
  });

  it('a failed spawn is logged and answered, never thrown, and nothing is remembered', async () => {
    const daemon = daemonWith({
      startSession: jest.fn(async () => {
        throw new Error('spawn-failed');
      }),
    });
    const deps = depsWith(run(), daemon);
    await expect(warmRun(deps, 'run-abc1234')).resolves.toEqual({
      kind: 'failed',
      message: 'spawn-failed',
    });
    expect(takeWarmed('run-abc1234')).toBeNull();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('the engine down throws', async () => {
    await expect(warmRun(depsWith(run(), null), 'run-abc1234')).rejects.toThrow(
      /engine is not running/,
    );
  });
});
