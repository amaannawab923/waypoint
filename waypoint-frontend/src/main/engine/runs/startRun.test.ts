import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DaemonRunsApi, DaemonWorkspaceRecord } from './daemonApi';
import type { PendingPrompt } from '../types';
import {
  LedgerRequestError,
  type AgentRun,
  type LedgerClient,
} from './ledgerClient';
import { createFolderRegistry, type FolderDeps } from './folders';
import {
  buildResumeNote,
  continueStart,
  ENGINE_NOT_RUNNING,
  listRunBranches,
  RESUMABLE_RUN_STATUSES,
  resumeRun,
  resumeRunCore,
  startRun,
  titleFromMessage,
  validateStartInput,
  type StartRunDeps,
} from './startRun';

// The W4 start and resume sequences against fakes of the ledger and the
// daemon (docs/design/w4-start-session.md §6). Every path the design names
// is one test: the order of writes on the happy path, a Stop landing
// between steps, a failure at either stage, and resume's two outcomes.

let worktreesDir: string;
/** A git repository (a `.git` directory) — the linked repository the fake ledger names. */
let repoDir: string;
/** A plain folder: no `.git`. */
let plainDir: string;
let recentsFile: string;
beforeAll(() => {
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-repo-')));
  fs.mkdirSync(path.join(repoDir, '.git'));
  plainDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wp-plain-')),
  );
  // realpath'd: macOS's /var is /private/var, and assertUnder compares
  // canonical paths (a fake record's path must be canonical too).
  worktreesDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wp-start-')),
  );
  recentsFile = path.join(worktreesDir, 'recent-folders.json');
});
afterAll(() => {
  fs.rmSync(worktreesDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(plainDir, { recursive: true, force: true });
});

/** The handles a test hands `runs:start`, minted the way main does. */
const registry = createFolderRegistry();
const handleOf = (dir: string) => registry.mint(dir);

function run(overrides: Partial<AgentRun> = {}): AgentRun {
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
    providerSessionId: null,
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    prUrl: null,
    status: 'queued',
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

/** A ledger that keeps its rows: updates are visible to later reads. */
function fakeLedger(seed: AgentRun[] = [], pendingSeed: PendingPrompt[] = []) {
  const rows = new Map(seed.map((r) => [r.id, r]));
  const pending = new Map(pendingSeed.map((p) => [p.id, p]));
  const ledger = {
    listPendingPrompts: jest.fn(async (runId: string) =>
      [...pending.values()]
        .filter((p) => p.runId === runId)
        .sort((a, b) => a.seq - b.seq),
    ),
    updatePendingPrompt: jest.fn(
      async (
        _runId: string,
        pendingId: string,
        patch: Partial<PendingPrompt>,
      ) => {
        const current = pending.get(pendingId);
        if (!current) throw new Error(`no pending prompt ${pendingId}`);
        const next = {
          ...current,
          ...patch,
          claimedAt:
            patch.state === 'queued' ? null : (current.claimedAt ?? null),
        } as PendingPrompt;
        pending.set(pendingId, next);
        return next;
      },
    ),
    listProjects: jest.fn(async () => [
      { id: 'proj-1', name: 'Waypoint', repoPath: repoDir },
      { id: 'proj-nolink', name: 'Docs', repoPath: null },
      { id: 'proj-gone', name: 'Compass', repoPath: '~/code/compass-web' },
    ]),
    getProject: jest.fn(async (id: string) => {
      if (id === 'proj-1') return { id, name: 'Waypoint', repoPath: repoDir };
      if (id === 'proj-nolink') return { id, name: 'Docs', repoPath: null };
      if (id === 'proj-gone')
        return { id, name: 'Compass', repoPath: '~/code/compass-web' };
      return null;
    }),
    createRun: jest.fn(async (input) => {
      const created = run({ ...input, id: 'run-new0001', status: 'queued' });
      rows.set(created.id, created);
      return created;
    }),
    getRun: jest.fn(async (id: string) => rows.get(id) ?? null),
    updateRun: jest.fn(async (id: string, patch) => {
      const current = rows.get(id);
      if (!current) throw new Error(`no row ${id}`);
      // The real ledger's rule (agentRuns.service.ts): a finished row is
      // read-only — found live when reprovisionWorktree wrote to a
      // cancelled row and died on the 409. Modelled here so a write in
      // the wrong order can't pass these tests again.
      if (current.status === 'failed' || current.status === 'cancelled') {
        throw new Error(
          `A ${current.status} run is finished; its record is read-only.`,
        );
      }
      const fields = { ...patch };
      delete fields.reason;
      const next = { ...current, ...fields } as AgentRun;
      rows.set(id, next);
      return next;
    }),
    reopenRun: jest.fn(async (id: string) => {
      const current = rows.get(id);
      if (!current) throw new Error(`no row ${id}`);
      const from = current.status;
      const next = { ...current, status: 'provisioning' } as AgentRun;
      rows.set(id, next);
      return { run: next, from };
    }),
    appendEvent: jest.fn(async () => ({}) as never),
    listRuns: jest.fn(),
    listAllRuns: jest.fn(),
  } as unknown as jest.Mocked<LedgerClient>;
  return { ledger, rows, pending };
}

// Overrides are loosely typed on purpose: a scripted answer is a
// `jest.fn(async () => …)` whose parameter list the real signature need
// not constrain.
function fakeDaemon(
  overrides: Partial<Record<keyof DaemonRunsApi, unknown>> = {},
) {
  const record = (id: string): DaemonWorkspaceRecord => ({
    id,
    kind: 'worktree',
    path: path.join(worktreesDir, id),
    parentId: 'repo-1',
    observedStatus: 'present',
    creation: { branch: 'session/new0001', baseRef: 'main', requestedPath: '' },
    lifecycle: null,
    lastCreateOutcome: { status: 'succeeded', at: 1 },
  });
  return {
    registerRepository: jest.fn(async (id: string, p: string) => ({
      ...record(id),
      kind: 'repository' as const,
      path: p,
      creation: null,
    })),
    disableArtifactCopy: jest.fn(async () => {}),
    createWorktree: jest.fn(async (req) => record(req.workspaceId)),
    deleteWorktree: jest.fn(async () => {}),
    listLocalBranches: jest.fn(async () => ['main', 'feat/x']),
    listRefs: jest.fn(async () => ({
      branches: ['feat/x', 'main', 'master'],
      remoteHeads: [{ remote: 'origin', branch: 'master' }],
    })),
    listWorkspaceRecords: jest.fn(),
    listSessions: jest.fn(),
    startSession: jest.fn(async () => ({ sessionId: 'sess-1' })),
    sendPrompt: jest.fn(async () => {}),
    cancelTurn: jest.fn(async () => {}),
    killSession: jest.fn(async () => {}),
    ...overrides,
  } as unknown as jest.Mocked<DaemonRunsApi>;
}

function depsWith(
  ledger: LedgerClient,
  daemon: DaemonRunsApi | null,
  extra: Partial<StartRunDeps> = {},
): StartRunDeps & { daemonApi: DaemonRunsApi; notify: jest.Mock } {
  const notify = jest.fn();
  return {
    ledger,
    daemon: () => daemon,
    daemonApi: daemon as DaemonRunsApi,
    worktreesDir,
    git: jest.fn(async () => ({ stdout: '', code: 0 })),
    assertWorktreeGitDir: jest.fn(async () => {}),
    folders: {
      registry,
      recentsFile,
      listProjects: () => ledger.listProjects(),
    } satisfies FolderDeps,
    logger: { info: jest.fn(), warn: jest.fn() },
    ...extra,
    notify,
  };
}

const goodInput = {
  get folder() {
    return handleOf(repoDir);
  },
  ownerMemberId: 'mem-1',
  providerId: 'claude',
  isolation: 'worktree',
  autoApprove: true,
  baseRef: 'main',
  firstMessage: '  Fix the flaky test\nIt fails on CI only.  ',
};

beforeEach(() => {
  jest.clearAllMocks();
  fs.rmSync(recentsFile, { force: true });
});

describe('validateStartInput', () => {
  it('trims the first message and names the run by its first line', () => {
    const v = validateStartInput(goodInput);
    expect(v.firstMessage).toBe('Fix the flaky test\nIt fails on CI only.');
    expect(v.title).toBe('Fix the flaky test');
    expect(
      validateStartInput({ ...goodInput, firstMessage: '   ' }),
    ).toMatchObject({
      firstMessage: null,
      title: null,
    });
    expect(titleFromMessage(`${'x'.repeat(200)}\nmore`)).toHaveLength(120);
    expect(titleFromMessage('\n\n  second line  ')).toBe('second line');
  });

  it('a direct run needs no base branch; a worktree run does', () => {
    expect(
      validateStartInput({
        ...goodInput,
        isolation: 'directory',
        baseRef: null,
      }).baseRef,
    ).toBeNull();
    expect(() =>
      validateStartInput({ ...goodInput, isolation: 'worktree', baseRef: '' }),
    ).toThrow(/base branch/);
  });

  it('refuses an unsupported provider, a bad ref, a long message, a missing isolation or auto-approve, and no folder', () => {
    expect(() =>
      validateStartInput({ ...goodInput, providerId: 'codex' }),
    ).toThrow(/not one Waypoint can start/);
    expect(() => validateStartInput({ ...goodInput, baseRef: '-rf' })).toThrow(
      /base branch/,
    );
    expect(() =>
      validateStartInput({ ...goodInput, firstMessage: 'x'.repeat(20_001) }),
    ).toThrow(/20000/);
    expect(() =>
      validateStartInput({ ...goodInput, isolation: 'somewhere' }),
    ).toThrow(/where the agent should work/);
    expect(() =>
      validateStartInput({ ...goodInput, autoApprove: 'yes' }),
    ).toThrow(/without asking/);
    expect(() => validateStartInput({ ...goodInput, folder: '' })).toThrow(
      /Choose a folder/,
    );
    expect(() => validateStartInput(null)).toThrow();
  });
});

describe('startRun', () => {
  it('refuses before any write: engine down, a handle it never minted, a folder that is gone, a worktree of a plain folder, an unknown branch', async () => {
    const { ledger } = fakeLedger();
    await expect(startRun(depsWith(ledger, null), goodInput)).rejects.toThrow(
      ENGINE_NOT_RUNNING,
    );
    const daemon = fakeDaemon();
    await expect(
      startRun(depsWith(ledger, daemon), { ...goodInput, folder: 'f-forged' }),
    ).rejects.toThrow(/not one this window offered/);
    const gone = handleOf(path.join(plainDir, 'moved-away'));
    await expect(
      startRun(depsWith(ledger, daemon), { ...goodInput, folder: gone }),
    ).rejects.toThrow(/not a folder on this machine any more/);
    await expect(
      startRun(depsWith(ledger, daemon), {
        ...goodInput,
        folder: handleOf(plainDir),
      }),
    ).rejects.toThrow(/not a git repository, so there is no branch/);
    await expect(
      startRun(depsWith(ledger, daemon), { ...goodInput, baseRef: 'release' }),
    ).rejects.toThrow(/release is not a local branch of/);
    expect(ledger.createRun).not.toHaveBeenCalled();
    expect(ledger.updateRun).not.toHaveBeenCalled();
    expect(fs.existsSync(recentsFile)).toBe(false);
  });

  it('creates the row, answers at provisioning, and notifies', async () => {
    const { ledger } = fakeLedger();
    const daemon = fakeDaemon({
      // Hold the start so the answer is observed before it completes.
      startSession: jest.fn(() => new Promise(() => {})),
    });
    const deps = depsWith(ledger, daemon);

    const answered = await startRun(deps, goodInput);

    expect(answered.status).toBe('provisioning');
    // The folder is the linked repository of proj-1: the run belongs to it.
    expect(ledger.createRun).toHaveBeenCalledWith({
      projectId: 'proj-1',
      ownerMemberId: 'mem-1',
      entry: 'independent',
      providerId: 'claude',
      isolation: 'worktree',
      autoApprove: true,
      modeId: 'bypassPermissions',
      baseRef: 'main',
      title: 'Fix the flaky test',
    });
    // The folder is remembered with its auto-approve choice.
    const recents = JSON.parse(fs.readFileSync(recentsFile, 'utf8'));
    expect(recents).toEqual([
      expect.objectContaining({ path: repoDir, autoApprove: true }),
    ]);
    expect(deps.notify).toHaveBeenCalledWith({
      runId: 'run-new0001',
      status: 'provisioning',
    });
  });
});

describe('continueStart', () => {
  it('provisions, starts, then writes running with the provider session id — in that order', async () => {
    const { ledger, rows } = fakeLedger([
      run({ id: 'run-a1', status: 'provisioning' }),
    ]);
    const daemon = fakeDaemon();
    const deps = depsWith(ledger, daemon);

    await continueStart(deps, rows.get('run-a1') as AgentRun, repoDir);

    const startOrder = daemon.startSession.mock.invocationCallOrder[0];
    const worktreeOrder = daemon.createWorktree.mock.invocationCallOrder[0];
    expect(worktreeOrder).toBeLessThan(startOrder);
    expect(daemon.startSession).toHaveBeenCalledWith({
      conversationId: 'run-a1',
      providerId: 'claude',
      cwd: path.join(worktreesDir, 'run-a1'),
      sessionId: null,
      modeId: null,
    });
    const runningWrite = ledger.updateRun.mock.calls.find(
      ([, patch]) => patch.status === 'running',
    );
    expect(runningWrite?.[1]).toMatchObject({
      status: 'running',
      daemonSessionId: 'run-a1',
      providerSessionId: 'sess-1',
      cwd: path.join(worktreesDir, 'run-a1'),
    });
    expect(ledger.updateRun.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      startOrder,
    );
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-a1',
      'session_started',
      expect.objectContaining({ providerSessionId: 'sess-1' }),
    );
    expect(deps.notify).toHaveBeenLastCalledWith({
      runId: 'run-a1',
      status: 'running',
    });
    expect(rows.get('run-a1')?.status).toBe('running');
  });

  it('does not start the session when a Stop landed during the worktree', async () => {
    const { ledger, rows } = fakeLedger([
      run({ id: 'run-a1', status: 'provisioning' }),
    ]);
    const daemon = fakeDaemon({
      createWorktree: jest.fn(async (req) => {
        // Stop from the panel, mid-provision: the ledger says cancelled.
        rows.set('run-a1', {
          ...(rows.get('run-a1') as AgentRun),
          status: 'cancelled',
        });
        return {
          id: req.workspaceId,
          kind: 'worktree',
          path: path.join(worktreesDir, req.workspaceId),
          parentId: 'repo-1',
          observedStatus: 'present',
          creation: {
            branch: req.branch,
            baseRef: req.baseRef,
            requestedPath: req.path,
          },
          lifecycle: null,
          lastCreateOutcome: { status: 'succeeded', at: 1 },
        };
      }),
    });

    await continueStart(
      depsWith(ledger, daemon),
      rows.get('run-a1') as AgentRun,
      repoDir,
    );

    expect(daemon.startSession).not.toHaveBeenCalled();
    expect(daemon.killSession).not.toHaveBeenCalled();
    expect(rows.get('run-a1')?.status).toBe('cancelled');
  });

  it('kills the session it just started when a Stop landed during acp.start', async () => {
    const { ledger, rows } = fakeLedger([
      run({ id: 'run-a1', status: 'provisioning' }),
    ]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => {
        rows.set('run-a1', {
          ...(rows.get('run-a1') as AgentRun),
          status: 'cancelled',
        });
        return { sessionId: 'sess-1' };
      }),
    });

    await continueStart(
      depsWith(ledger, daemon),
      rows.get('run-a1') as AgentRun,
      repoDir,
    );

    expect(daemon.killSession).toHaveBeenCalledWith('run-a1');
    expect(
      ledger.updateRun.mock.calls.some(([, p]) => p.status === 'running'),
    ).toBe(false);
    expect(rows.get('run-a1')?.status).toBe('cancelled');
  });

  it('reverts outbox rows folded into a killed start’s initialQueue back to `queued` — never `delivered` for a session the agent may never have seen', async () => {
    const pendingRow: PendingPrompt = {
      id: 'pp-1',
      runId: 'run-a1',
      seq: 1,
      byMemberId: 'mem-1',
      text: 'typed while starting',
      reason: 'starting',
      state: 'queued',
      autoAttempts: 0,
      lastError: null,
      claimedAt: null,
      resolvedAt: null,
      createdAt: '2026-09-20T00:00:00.000Z',
    };
    const { ledger, rows, pending } = fakeLedger(
      [run({ id: 'run-a1', status: 'provisioning' })],
      [pendingRow],
    );
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => {
        rows.set('run-a1', {
          ...(rows.get('run-a1') as AgentRun),
          status: 'cancelled',
        });
        return { sessionId: 'sess-1' };
      }),
    });

    await continueStart(
      depsWith(ledger, daemon),
      rows.get('run-a1') as AgentRun,
      repoDir,
    );

    expect(daemon.killSession).toHaveBeenCalledWith('run-a1');
    // Not `delivered` — this start's session was killed before anyone
    // could tell whether the agent ever acted on its initial queue.
    expect(pending.get('pp-1')).toMatchObject({
      state: 'queued',
      claimedAt: null,
    });
  });

  it('a Stop that lands while the worktree is being made: no failure recorded, no session', async () => {
    const { ledger, rows } = fakeLedger([
      run({ id: 'run-a1', status: 'provisioning' }),
    ]);
    // The worktree finishes after the cancel; the ledger then refuses
    // the worktree write the way the real one does (409, read-only).
    ledger.updateRun.mockImplementation(async (id, patch) => {
      const current = rows.get(id) as AgentRun;
      if (current.status === 'cancelled') {
        throw new LedgerRequestError(
          409,
          'A cancelled run is finished; its record is read-only.',
        );
      }
      const next = { ...current, ...patch } as AgentRun;
      rows.set(id, next);
      return next;
    });
    const daemon = fakeDaemon({
      createWorktree: jest.fn(async (req) => {
        rows.set('run-a1', {
          ...(rows.get('run-a1') as AgentRun),
          status: 'cancelled',
        });
        return {
          id: req.workspaceId,
          kind: 'worktree',
          path: path.join(worktreesDir, req.workspaceId),
          parentId: 'repo-1',
          observedStatus: 'present',
          creation: {
            branch: req.branch,
            baseRef: req.baseRef,
            requestedPath: req.path,
          },
          lifecycle: null,
          lastCreateOutcome: { status: 'succeeded', at: 1 },
        };
      }),
    });
    const deps = depsWith(ledger, daemon);

    await continueStart(deps, rows.get('run-a1') as AgentRun, repoDir);

    expect(daemon.startSession).not.toHaveBeenCalled();
    expect(ledger.appendEvent).not.toHaveBeenCalledWith(
      'run-a1',
      'error',
      expect.anything(),
    );
    expect(rows.get('run-a1')?.status).toBe('cancelled');
    expect(deps.notify).not.toHaveBeenCalledWith({
      runId: 'run-a1',
      status: 'failed',
    });
  });

  it('a worktree failure is failed/provision (worktrees.ts recorded the detail)', async () => {
    const { ledger, rows } = fakeLedger([
      run({ id: 'run-a1', status: 'provisioning' }),
    ]);
    const daemon = fakeDaemon({
      createWorktree: jest.fn(async () => {
        throw new Error('stage-failed: add-worktree: branch checked out');
      }),
    });
    const deps = depsWith(ledger, daemon);

    await continueStart(deps, rows.get('run-a1') as AgentRun, repoDir);

    const row = rows.get('run-a1');
    expect(row?.status).toBe('failed');
    expect(row?.errorKind).toBe('provision');
    expect(daemon.startSession).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenLastCalledWith({
      runId: 'run-a1',
      status: 'failed',
    });
  });

  it("a start failure is failed/start with the daemon's sentence and an error event", async () => {
    const { ledger, rows } = fakeLedger([
      run({ id: 'run-a1', status: 'provisioning' }),
    ]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => {
        throw new Error('acp.start: auth-required: run `claude` and log in');
      }),
    });

    await continueStart(
      depsWith(ledger, daemon),
      rows.get('run-a1') as AgentRun,
      repoDir,
    );

    const row = rows.get('run-a1');
    expect(row?.status).toBe('failed');
    expect(row?.errorKind).toBe('start');
    expect(row?.errorMessage).toContain('auth-required');
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-a1',
      'error',
      expect.objectContaining({ stage: 'session' }),
    );
  });
});

describe('continueStart (W4b)', () => {
  it('a direct run skips the worktree, runs in the folder, and writes cwd', async () => {
    const { ledger, rows } = fakeLedger([
      run({
        id: 'run-d1',
        status: 'provisioning',
        isolation: 'directory',
        cwd: plainDir,
        baseRef: null,
      }),
    ]);
    const daemon = fakeDaemon();
    const deps = depsWith(ledger, daemon);

    await continueStart(deps, rows.get('run-d1') as AgentRun, plainDir);

    expect(daemon.createWorktree).not.toHaveBeenCalled();
    expect(daemon.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: plainDir, modeId: null }),
    );
    expect(rows.get('run-d1')).toMatchObject({
      status: 'running',
      cwd: plainDir,
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-d1',
      'session_started',
      expect.objectContaining({ isolation: 'directory', branch: null }),
    );
  });

  it('auto-approve starts the session in the bypass mode; the first message rides in as the initial queue and is recorded', async () => {
    const { ledger, rows } = fakeLedger([
      run({
        id: 'run-d2',
        status: 'provisioning',
        isolation: 'directory',
        cwd: plainDir,
        autoApprove: true,
      }),
    ]);
    const daemon = fakeDaemon();

    await continueStart(
      depsWith(ledger, daemon),
      rows.get('run-d2') as AgentRun,
      plainDir,
      'Say hi',
    );

    expect(daemon.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modeId: 'bypassPermissions',
        initialQueue: [{ text: 'Say hi' }],
      }),
    );
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-d2',
      'prompt_sent',
      expect.objectContaining({ by: 'user', kind: 'first-message' }),
    );
  });

  it('startRun on a plain folder makes a direct run of no project, and the recents remember auto-approve off', async () => {
    const { ledger } = fakeLedger();
    const daemon = fakeDaemon({
      startSession: jest.fn(() => new Promise(() => {})),
    });
    const deps = depsWith(ledger, daemon);
    const answered = await startRun(deps, {
      ...goodInput,
      folder: handleOf(plainDir),
      isolation: 'directory',
      autoApprove: false,
      baseRef: null,
    });
    expect(answered).toMatchObject({ status: 'provisioning', cwd: plainDir });
    expect(ledger.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        isolation: 'directory',
        autoApprove: false,
      }),
    );
    expect(ledger.createRun.mock.calls[0][0]).not.toHaveProperty('baseRef');
    expect(JSON.parse(fs.readFileSync(recentsFile, 'utf8'))).toEqual([
      expect.objectContaining({ path: plainDir, autoApprove: false }),
    ]);
  });
});

describe('resumeRun', () => {
  function interrupted(overrides: Partial<AgentRun> = {}): AgentRun {
    const worktreePath = path.join(worktreesDir, 'run-i1');
    fs.mkdirSync(worktreePath, { recursive: true });
    return run({
      id: 'run-i1',
      status: 'interrupted',
      worktreePath,
      branch: 'session/i1',
      baseRef: 'main',
      providerSessionId: 'sess-old',
      ...overrides,
    });
  }

  // Never-lock (2026-09-20): every status that is not live can be
  // continued — done and needs-review too. Only a live run has nothing
  // to reopen; that is `already-live`, never a refusal.
  it('is already-live for a live status, and continues done and needs-review like any other', async () => {
    const { ledger, rows } = fakeLedger([
      run({ id: 'run-r1', status: 'running' }),
      interrupted({
        id: 'run-d1',
        status: 'done',
        providerSessionId: 'sess-old',
      }),
      interrupted({
        id: 'run-nr1',
        status: 'needs-review',
        providerSessionId: 'sess-old',
      }),
    ]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    });
    const deps = depsWith(ledger, daemon);
    await expect(resumeRun(deps, 'run-r1')).resolves.toEqual({
      outcome: 'already-live',
      status: 'running',
    });
    expect(ledger.reopenRun).not.toHaveBeenCalled();

    await expect(resumeRun(deps, 'run-d1')).resolves.toEqual({
      outcome: 'loaded',
      status: 'running',
    });
    expect(ledger.reopenRun).toHaveBeenCalledWith(
      'run-d1',
      'Resume from the sessions panel',
    );
    expect(rows.get('run-d1')?.status).toBe('running');
    await expect(resumeRun(deps, 'run-nr1')).resolves.toMatchObject({
      outcome: 'loaded',
      status: 'running',
    });
  });

  // ROAD-XXX: found live (the founder's own words) — a worktree missing,
  // or never successfully made, used to end the run for good. Now it is
  // recreated transparently: the run's own branch when it still exists,
  // else a fresh one of the same name from baseRef.
  it('reprovisions a missing worktree instead of refusing, reusing the run’s own branch when it still exists', async () => {
    const { ledger, rows } = fakeLedger([
      interrupted({ id: 'run-i2', worktreePath: null, branch: null }),
      interrupted({
        id: 'run-i3',
        worktreePath: path.join(worktreesDir, 'never-made'),
      }),
    ]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    });
    const deps = depsWith(ledger, daemon);

    // run-i2 never had a branch (died before provisionWorktree got that
    // far) — chooseBranchName mints one, session/i2, since the daemon's
    // own listLocalBranches ('main', 'feat/x') doesn't have it.
    await expect(resumeRun(deps, 'run-i2')).resolves.toEqual({
      outcome: 'loaded',
      status: 'running',
      worktreeRecreated: true,
      branchReused: false,
    });
    expect(daemon.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'run-i2',
        branch: 'session/i2',
        baseRef: 'main',
        path: path.join(worktreesDir, 'run-i2'),
      }),
    );
    // The recreated worktree's fields land on the row — but only after
    // reopenRun, the row being read-only until then (the fake ledger
    // above refuses the write on a terminal row, as the real one does).
    // (The branch recorded is the daemon's own answer, not the requested
    // name — fakeDaemon's record says session/new0001 — the same
    // "daemon is authoritative" rule provisionWorktree keeps.)
    expect(ledger.updateRun).toHaveBeenCalledWith(
      'run-i2',
      expect.objectContaining({
        worktreePath: path.join(worktreesDir, 'run-i2'),
        baseRef: 'main',
        daemonWorkspaceId: 'run-i2',
      }),
    );
    expect(rows.get('run-i2')).toMatchObject({
      status: 'running',
      worktreePath: path.join(worktreesDir, 'run-i2'),
    });

    // run-i3 already has a branch (session/i1, from the interrupted()
    // fixture) that the daemon's listLocalBranches doesn't know about —
    // still reused as the target name; whether it's genuinely reused or
    // freshly cut from baseRef is the daemon's own git-level call, not
    // Waypoint's (branchReused here reflects only what Waypoint could see
    // from listLocalBranches).
    await expect(resumeRun(deps, 'run-i3')).resolves.toEqual({
      outcome: 'loaded',
      status: 'running',
      worktreeRecreated: true,
      branchReused: false,
    });
    expect(daemon.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'run-i3',
        branch: 'session/i1',
        path: path.join(worktreesDir, 'run-i3'),
      }),
    );
  });

  // Never-lock: a worktree that cannot be reached and cannot be
  // recreated is not a refusal — the caller (sendPrompt.ts) accepts the
  // message into the outbox under the reason answered here.
  it('cannot-reach-worktree, with the outbox reason, when there is no linked repository to reprovision from', async () => {
    const { ledger } = fakeLedger([
      interrupted({
        id: 'run-i4',
        worktreePath: null,
        projectId: 'proj-nolink',
      }),
      interrupted({
        id: 'run-i5',
        worktreePath: null,
        projectId: 'proj-ghost',
      }),
    ]);
    const deps = depsWith(ledger, fakeDaemon());
    // proj-nolink: a real project, but nothing is linked (repoPath: null).
    await expect(resumeRun(deps, 'run-i4')).resolves.toMatchObject({
      outcome: 'cannot-reach-worktree',
      status: 'interrupted',
      reason: 'repository-missing',
    });
    // proj-ghost: not a project getProject knows at all.
    await expect(resumeRun(deps, 'run-i5')).resolves.toMatchObject({
      outcome: 'cannot-reach-worktree',
      reason: 'repository-missing',
    });
    expect(ledger.reopenRun).not.toHaveBeenCalled();
  });

  it("cannot-reach-worktree when reprovisioning itself fails, carrying the daemon's sentence", async () => {
    const { ledger } = fakeLedger([interrupted({ worktreePath: null })]);
    const daemon = fakeDaemon({
      createWorktree: jest.fn(async () => {
        throw new Error('daemon: repository unreachable');
      }),
    });
    const deps = depsWith(ledger, daemon);
    await expect(resumeRun(deps, 'run-i1')).resolves.toMatchObject({
      outcome: 'cannot-reach-worktree',
      status: 'interrupted',
      reason: 'repository-missing',
      message: 'daemon: repository unreachable',
    });
    expect(ledger.reopenRun).not.toHaveBeenCalled();
  });

  it('a directory-isolation run whose folder is gone is cannot-reach-worktree with folder-missing — nothing to recreate it from', async () => {
    const { ledger } = fakeLedger([
      interrupted({
        id: 'run-dir',
        isolation: 'directory',
        cwd: path.join(worktreesDir, 'gone-folder'),
        worktreePath: null,
      }),
    ]);
    await expect(
      resumeRun(depsWith(ledger, fakeDaemon()), 'run-dir'),
    ).resolves.toMatchObject({
      outcome: 'cannot-reach-worktree',
      reason: 'folder-missing',
    });
    expect(ledger.reopenRun).not.toHaveBeenCalled();
  });

  it('a daemon refusal returns the run to its ORIGINAL status, not unconditionally interrupted — a failed run whose resume also fails stays failed', async () => {
    const { ledger, rows } = fakeLedger([interrupted({ status: 'failed' })]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => {
        throw new Error('spawn-failed: no such provider');
      }),
    });
    const deps = depsWith(ledger, daemon);

    // Never-lock: answered, not thrown — the caller outboxes the message
    // under `spawn-failed` rather than refusing it.
    await expect(resumeRun(deps, 'run-i1')).resolves.toMatchObject({
      outcome: 'spawn-failed',
      status: 'failed',
      reason: 'spawn-failed',
      message: 'spawn-failed: no such provider',
    });
    expect(rows.get('run-i1')).toMatchObject({
      status: 'failed',
      errorKind: 'resume',
    });
    expect(
      deps.notify.mock.calls.map(([c]: [{ status: string }]) => c.status),
    ).toEqual(['provisioning', 'failed']);
  });

  it("a refusal from reopenRun itself (live, or another member's run) propagates and never reaches the daemon", async () => {
    const { ledger } = fakeLedger([interrupted({ status: 'cancelled' })]);
    const daemon = fakeDaemon();
    const deps = depsWith(ledger, daemon);
    (ledger.reopenRun as jest.Mock).mockRejectedValueOnce(
      new Error(
        'Run run-i1 was superseded by a retry (run-i9); open that one instead.',
      ),
    );

    await expect(resumeRun(deps, 'run-i1')).rejects.toThrow(
      /superseded by a retry/,
    );
    expect(daemon.startSession).not.toHaveBeenCalled();
  });

  // ROAD-XXX: a gitdir check that fails no longer refuses outright — it
  // reprovisions instead (found live: a worktree that fails this check is
  // exactly as unusable as one that's outright missing, and deserves the
  // same recovery). What this test still pins: the check runs BEFORE
  // `daemon.startSession`, gating what cwd that call actually receives —
  // not only reached later, inside the fire-and-forget resume note, once
  // the (wrong) session has already started.
  it('checks the worktree gitdir BEFORE starting the session — a failure reprovisions rather than handing the daemon the untrusted cwd', async () => {
    const { ledger } = fakeLedger([interrupted({ status: 'failed' })]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    });
    const assertWorktreeGitDir = jest.fn(async () => {
      throw new Error('not a linked worktree');
    });
    const deps = depsWith(ledger, daemon, { assertWorktreeGitDir });

    await expect(resumeRun(deps, 'run-i1')).resolves.toEqual({
      outcome: 'loaded',
      status: 'running',
      worktreeRecreated: true,
      branchReused: false,
    });
    expect(assertWorktreeGitDir).toHaveBeenCalledWith(
      path.join(worktreesDir, 'run-i1'),
    );
    // createWorktree ran, and startSession only after it — the reprovision
    // this check triggered, not a straight pass-through of the untrusted
    // cwd once the check had already failed.
    expect(daemon.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'run-i1' }),
    );
    expect(daemon.createWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      daemon.startSession.mock.invocationCallOrder[0],
    );
  });

  it('refuses a worktree path outside worktreesDir', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-outside-'));
    const { ledger } = fakeLedger([interrupted({ worktreePath: outside })]);
    await expect(
      resumeRun(depsWith(ledger, fakeDaemon()), 'run-i1'),
    ).rejects.toThrow(/outside/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('loaded: hands the stored session id back and writes running; no note', async () => {
    const { ledger, rows } = fakeLedger([interrupted()]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    });
    const deps = depsWith(ledger, daemon);

    await expect(resumeRun(deps, 'run-i1')).resolves.toEqual({
      outcome: 'loaded',
      status: 'running',
    });
    expect(daemon.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'run-i1',
        sessionId: 'sess-old',
      }),
    );
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-i1',
      'session_resumed',
      expect.objectContaining({ outcome: 'loaded' }),
    );
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
    expect(rows.get('run-i1')).toMatchObject({
      status: 'running',
      providerSessionId: 'sess-old',
      daemonSessionId: 'run-i1',
    });
    expect(
      deps.notify.mock.calls.map(([c]: [{ status: string }]) => c.status),
    ).toEqual(['provisioning', 'running']);
  });

  // Never-lock (design §4.7): the branch-state note is no longer a prompt
  // turn of its own — it comes back as hiddenContext for the caller's
  // first real prompt, so a resume never spends an agent turn and leaves
  // no Waypoint-authored message in the transcript.
  it('replaced-by-new: keeps the new id and hands back the branch-state note as hiddenContext — no prompt of its own', async () => {
    const { ledger, rows } = fakeLedger([interrupted()]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-fresh' })),
    });
    const git = jest.fn(async (args: string[]) => ({
      stdout: args[0] === 'log' ? 'abc123 first commit\n' : ' M src/a.ts\n',
      code: 0,
    }));
    const deps = depsWith(ledger, daemon, { git });

    const result = await resumeRunCore(deps, 'run-i1', 'message');
    expect(result).toMatchObject({
      outcome: 'replaced-by-new',
      status: 'running',
    });
    expect(rows.get('run-i1')?.providerSessionId).toBe('sess-fresh');
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
    const note = result.hiddenContext ?? '';
    expect(note).toContain('could not be restored');
    expect(note).toContain('abc123 first commit');
    expect(note).toContain(' M src/a.ts');
    expect(note).toContain('session/i1 (from main)');
    expect(note).not.toContain('Wait for the next instruction');
    expect(deps.assertWorktreeGitDir).toHaveBeenCalledWith(
      rows.get('run-i1')?.worktreePath,
    );
    // The explicit Resume action drops the note (no prompt to attach it to).
    expect(
      await resumeRun(
        depsWith(fakeLedger([interrupted()]).ledger, daemon, { git }),
        'run-i1',
      ),
    ).not.toHaveProperty('hiddenContext');
    // A loaded session with nothing recreated carries no note at all —
    // and, with no snapshot to anchor its marker, the anchor is the last
    // turn of the daemon's restored history (found live: anchored to
    // nothing, the marker fell after the turn the message started).
    const loadedDaemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
      getHistory: jest.fn(async () => [
        { id: 'run-i1:turn:0', seq: 0, initiator: 'user', items: [] },
        { id: 'run-i1:turn:1', seq: 1, initiator: 'user', items: [] },
      ]),
    });
    const loadedLedger = fakeLedger([interrupted()]).ledger;
    expect(
      await resumeRunCore(
        depsWith(loadedLedger, loadedDaemon, { git }),
        'run-i1',
        'message',
      ),
    ).not.toHaveProperty('hiddenContext');
    expect(loadedLedger.appendEvent).toHaveBeenCalledWith(
      'run-i1',
      'session_resumed',
      expect.objectContaining({
        outcome: 'loaded',
        afterTurnId: 'run-i1:turn:1',
      }),
    );
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-i1',
      'session_resumed',
      expect.objectContaining({
        outcome: 'replaced-by-new',
        trigger: 'message',
        from: 'interrupted',
        afterTurnId: null,
      }),
    );
  });

  it('a dispatched run whose report is filed gets the continuation note (finalizeCount > 0), even when the session loaded', async () => {
    const { ledger } = fakeLedger([
      interrupted({
        status: 'done',
        entry: 'dispatched',
        finalizeCount: 1,
        verdict: 'fixed',
        ticketId: 'wi-1',
      }),
    ]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    });
    const result = await resumeRunCore(
      depsWith(ledger, daemon),
      'run-i1',
      'message',
    );
    expect(result.outcome).toBe('loaded');
    expect(result.hiddenContext).toMatch(/last report was already filed/);
    expect(result.hiddenContext).toMatch(/verdict: fixed/);
    expect(result.hiddenContext).toMatch(/Verdict:/);
  });

  it("a warmed session (warm.ts) is used as-is: no startSession, the warm-up's outcome decides loaded vs replaced-by-new", async () => {
    const { ledger, rows } = fakeLedger([interrupted({ status: 'done' })]);
    const daemon = fakeDaemon({
      // The warm-up's own session, still live per the daemon — the
      // liveness re-check (found in review: a warm-up never touches the
      // ledger, so a concurrent kill-stale can silently kill it) must
      // see this and trust the warm-up, not fall through to a fresh spawn.
      listSessions: jest.fn(async () => ({ 'run-i1': { conversationId: 'run-i1' } })),
    });
    const result = await resumeRunCore(
      depsWith(ledger, daemon),
      'run-i1',
      'open-then-message',
      {
        sessionId: 'sess-old',
        loaded: true,
      },
    );
    expect(result).toMatchObject({ outcome: 'loaded', status: 'running' });
    expect(daemon.startSession).not.toHaveBeenCalled();
    expect(rows.get('run-i1')).toMatchObject({
      status: 'running',
      providerSessionId: 'sess-old',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-i1',
      'session_resumed',
      expect.objectContaining({ trigger: 'open-then-message', from: 'done' }),
    );
  });

  // Found in review: warm.ts never touches the ledger, so boot reconcile's
  // kill-stale can kill a warmed session in the window between the
  // warm-up and this resume — trusting `warmed` unconditionally would
  // write the ledger to `running` for a session that no longer exists.
  it('a warmed session the daemon no longer has falls through to a real spawn, not a blind trust of the stale id', async () => {
    const { ledger, rows } = fakeLedger([interrupted({ status: 'done' })]);
    const daemon = fakeDaemon({
      // kill-stale got to it first: the daemon has nothing for this run.
      listSessions: jest.fn(async () => ({})),
      startSession: jest.fn(async () => ({ sessionId: 'sess-fresh' })),
    });
    const result = await resumeRunCore(
      depsWith(ledger, daemon),
      'run-i1',
      'open-then-message',
      { sessionId: 'sess-old', loaded: true },
    );
    expect(daemon.startSession).toHaveBeenCalledTimes(1);
    // A fresh spawn against a `done` run's own recorded session id counts
    // as `replaced-by-new`, same as the no-warm-up path would.
    expect(result).toMatchObject({ status: 'running' });
    expect(rows.get('run-i1')).toMatchObject({
      status: 'running',
      providerSessionId: 'sess-fresh',
    });
  });

  it("a recreated worktree on a fresh branch clears the run's PR, since the branch it was for is gone", async () => {
    const { ledger, rows } = fakeLedger([
      interrupted({
        status: 'done',
        worktreePath: null,
        prUrl: 'https://github.com/acme/w/pull/3',
      }),
    ]);
    // listLocalBranches lacks session/i1 → the branch is cut fresh.
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    });
    const result = await resumeRunCore(
      depsWith(ledger, daemon),
      'run-i1',
      'message',
    );
    expect(result).toMatchObject({
      worktreeRecreated: true,
      branchReused: false,
    });
    expect(rows.get('run-i1')?.prUrl).toBeNull();
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-i1',
      'note',
      expect.objectContaining({
        publish: 'pr-superseded',
        previousUrl: 'https://github.com/acme/w/pull/3',
      }),
    );
  });

  it('a direct run resumes in its folder, in the mode it was started with', async () => {
    const { ledger, rows } = fakeLedger([
      run({
        id: 'run-i9',
        status: 'interrupted',
        isolation: 'directory',
        cwd: plainDir,
        worktreePath: null,
        autoApprove: true,
        providerSessionId: 'sess-old',
      }),
    ]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    });
    await expect(
      resumeRun(depsWith(ledger, daemon), 'run-i9'),
    ).resolves.toEqual({
      outcome: 'loaded',
      status: 'running',
    });
    expect(daemon.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: plainDir,
        modeId: 'bypassPermissions',
        sessionId: 'sess-old',
      }),
    );
    expect(rows.get('run-i9')?.status).toBe('running');
  });

  it('a session that never had a provider id is a fresh start (replaced-by-new)', async () => {
    const { ledger } = fakeLedger([interrupted({ providerSessionId: null })]);
    const daemon = fakeDaemon();
    await expect(
      resumeRun(depsWith(ledger, daemon), 'run-i1'),
    ).resolves.toMatchObject({
      outcome: 'replaced-by-new',
    });
    expect(daemon.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null }),
    );
  });

  it('a daemon refusal returns the run to interrupted with the reason, answered as spawn-failed', async () => {
    const { ledger, rows } = fakeLedger([interrupted()]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => {
        throw new Error('acp.start: spawn-failed: claude not found');
      }),
    });
    const deps = depsWith(ledger, daemon);

    await expect(resumeRun(deps, 'run-i1')).resolves.toMatchObject({
      outcome: 'spawn-failed',
      status: 'interrupted',
    });
    expect(rows.get('run-i1')).toMatchObject({
      status: 'interrupted',
      errorKind: 'resume',
      errorMessage: expect.stringContaining('spawn-failed'),
    });
    expect(
      deps.notify.mock.calls.map(([c]: [{ status: string }]) => c.status),
    ).toEqual(['provisioning', 'interrupted']);
  });
});

describe('listRunBranches', () => {
  it("sorts the local branches and suggests origin's HEAD when it is local", async () => {
    const { ledger } = fakeLedger();
    await expect(
      listRunBranches(depsWith(ledger, fakeDaemon()), handleOf(repoDir)),
    ).resolves.toEqual({
      branches: ['feat/x', 'main', 'master'],
      suggested: 'master',
    });
  });

  it('falls back to main, then master, then the first, then null', async () => {
    const { ledger } = fakeLedger();
    const refsOf = (branches: string[]) =>
      fakeDaemon({
        listRefs: jest.fn(async () => ({ branches, remoteHeads: [] })),
      });
    await expect(
      listRunBranches(
        depsWith(ledger, refsOf(['dev', 'main'])),
        handleOf(repoDir),
      ),
    ).resolves.toMatchObject({ suggested: 'main' });
    await expect(
      listRunBranches(
        depsWith(ledger, refsOf(['dev', 'master'])),
        handleOf(repoDir),
      ),
    ).resolves.toMatchObject({ suggested: 'master' });
    await expect(
      listRunBranches(
        depsWith(ledger, refsOf(['zeta', 'alpha'])),
        handleOf(repoDir),
      ),
    ).resolves.toEqual({ branches: ['alpha', 'zeta'], suggested: 'alpha' });
    await expect(
      listRunBranches(depsWith(ledger, refsOf([])), handleOf(repoDir)),
    ).resolves.toEqual({ branches: [], suggested: null });
  });

  it('needs the engine, a minted handle, and a git repository', async () => {
    const { ledger } = fakeLedger();
    await expect(
      listRunBranches(depsWith(ledger, null), handleOf(repoDir)),
    ).rejects.toThrow(ENGINE_NOT_RUNNING);
    await expect(
      listRunBranches(depsWith(ledger, fakeDaemon()), 'f-forged'),
    ).rejects.toThrow(/not one this window offered/);
    await expect(
      listRunBranches(depsWith(ledger, fakeDaemon()), handleOf(plainDir)),
    ).rejects.toThrow(/is not a git repository/);
  });
});

describe('buildResumeNote', () => {
  it('bounds each section to NOTE_MAX_LINES and says when a base ref is missing', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `c${i} commit ${i}`).join(
      '\n',
    );
    const git = jest.fn(async (args: string[]) => ({
      stdout: args[0] === 'log' ? `${many}\n` : '',
      code: 0,
    }));
    const note = await buildResumeNote(
      { git, assertWorktreeGitDir: jest.fn(async () => {}) },
      {
        worktreePath: '/wt',
        branch: 'session/x',
        baseRef: null,
        providerSessionId: 'prov-old',
      },
    );
    expect(note).toContain('c39 commit 39');
    expect(note).not.toContain('c40 commit 40');
    expect(note).toContain('… (20 more)');
    expect(note).toContain('Uncommitted changes:\n(none)');
    expect(git).toHaveBeenCalledWith(expect.arrayContaining(['log', 'HEAD']), {
      cwd: '/wt',
    });
  });
});

// Never-lock: RESUMABLE_RUN_STATUSES is REVIVABLE_RUN_STATUSES copied
// across the repo boundary (the same way reconcile.test.ts holds
// LIVE_RUN_STATUSES to the backend's). A backend that widens or narrows
// what can be continued without this copy following would either refuse
// a send the backend would take, or reopen a run the backend refuses.
describe('RESUMABLE_RUN_STATUSES', () => {
  it("matches the backend's REVIVABLE_RUN_STATUSES exactly", () => {
    const backend = fs.readFileSync(
      path.join(
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
      /REVIVABLE_RUN_STATUSES[^=]*=\s*new Set\(\[([^\]]*)\]\)/,
    );
    expect(match).not.toBeNull();
    const backendList = [...match![1].matchAll(/'([a-z-]+)'/g)].map(
      (m) => m[1],
    );
    expect([...RESUMABLE_RUN_STATUSES]).toEqual(backendList);
  });
});
