import * as os from 'node:os';
import * as path from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { EngineSupervisor } from './supervisor';
import { RUNS_IPC, MAX_DIFF_PATCH_CHARS } from './types';
import type { DaemonRunsApi } from './runs/daemonApi';
import {
  LedgerRequestError,
  type AgentRun,
  type LedgerClient,
} from './runs/ledgerClient';
import {
  assertWorktreeGitDir,
  computeRunDiff,
  execGit,
  GIT_SAFE_CONFIG,
  MAX_UNTRACKED_FILE_BYTES,
  registerRunsIpc,
  type GitRunner,
} from './runsIpc';
import { withTicketDispatchLock } from './runs/dispatch';

// A real tmp dir: assertUnder realpaths both sides, so a made-up path
// would fail containment for the wrong reason (worktrees.test.ts does the
// same).
const worktreesDir = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), 'wp-runs-ipc-')),
);
/** A directory under worktreesDir shaped like `git worktree add` leaves it: a `.git` file whose gitdir is outside. */
const worktreeOf = (runId: string) => {
  const p = path.join(worktreesDir, runId);
  mkdirSync(p, { recursive: true });
  const gitdir = path.join(
    os.tmpdir(),
    'wp-runs-ipc-repo',
    '.git',
    'worktrees',
    runId,
  );
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(path.join(p, '.git'), `gitdir: ${gitdir}\n`);
  return p;
};

function fakeHost() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    host: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    },
    invoke: (channel: string, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)!(...args)),
  };
}

function fakeLedger(rows: Record<string, Partial<AgentRun>>) {
  return {
    getRun: jest.fn(async (id: string) =>
      rows[id] ? ({ id, ...rows[id] } as AgentRun) : null,
    ),
    updateRun: jest.fn(async (id: string, patch: Partial<AgentRun>) => ({
      ...(rows[id] as AgentRun),
      id,
      ...patch,
    })),
    appendEvent: jest.fn(async () => ({})),
  } as unknown as jest.Mocked<LedgerClient>;
}

function fakeDaemon(): jest.Mocked<DaemonRunsApi> {
  return {
    cancelTurn: jest.fn(async () => {}),
    killSession: jest.fn(async () => {}),
  } as unknown as jest.Mocked<DaemonRunsApi>;
}

const supervisorWith = (connected: boolean): EngineSupervisor =>
  ({
    client: () => (connected ? ({} as never) : null),
    getStatus: jest.fn(),
  }) as unknown as EngineSupervisor;

const logger = { info: jest.fn(), warn: jest.fn() };

/** A scripted git: answers by the first argument (the subcommand). */
function scriptedGit(
  answers: Record<
    string,
    | { stdout?: string; stderr?: string; code?: number }
    | ((args: string[]) => { stdout?: string; stderr?: string; code?: number })
  >,
): jest.MockedFunction<GitRunner> {
  // `diff` is asked four ways; the flag tells them apart. The runner's
  // `options` argument is recorded by the mock (the containment test reads
  // it) but never consulted here.
  const keyOf = (args: string[]): string => {
    if (args[0] !== 'diff') return args[0];
    const flag = ['--numstat', '--name-status', '--no-index'].find((f) =>
      args.includes(f),
    );
    return flag ? flag.slice(2) : 'diff';
  };
  const runner: GitRunner = async (args) => {
    const answer = answers[keyOf(args)] ?? {};
    const value = typeof answer === 'function' ? answer(args) : answer;
    return {
      stdout: value.stdout ?? '',
      stderr: value.stderr ?? '',
      code: value.code ?? 0,
    };
  };
  return jest.fn(runner);
}

beforeEach(() => jest.clearAllMocks());

describe('runs:stop', () => {
  it('writes cancelled first, then cancels the turn and kills the session, and records the end', async () => {
    const { host, invoke } = fakeHost();
    const ledger = fakeLedger({ 'run-a1': { status: 'running' } });
    const daemon = fakeDaemon();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => daemon,
      logger,
    });

    await expect(invoke(RUNS_IPC.stop, 'run-a1')).resolves.toEqual({
      outcome: 'stopped',
      status: 'cancelled',
    });
    expect(daemon.cancelTurn).toHaveBeenCalledWith('run-a1');
    expect(daemon.killSession).toHaveBeenCalledWith('run-a1');
    expect(ledger.updateRun).toHaveBeenCalledWith('run-a1', {
      status: 'cancelled',
      reason: 'Stopped from the sessions panel',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith('run-a1', 'session_ended', {
      reason: 'stopped',
      daemonConfirmed: true,
    });
    // The ledger is written before the daemon is told (the live follower
    // must find a run that is over, not a blocked run with nothing
    // pending).
    const order = [
      ledger.updateRun.mock.invocationCallOrder[0],
      daemon.cancelTurn.mock.invocationCallOrder[0],
      daemon.killSession.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('snapshots the transcript before the kill (ROAD-124)', async () => {
    const { host, invoke } = fakeHost();
    const ledger = fakeLedger({ 'run-a1': { status: 'running' } });
    const daemon = fakeDaemon();
    const capture = jest.fn(async () => {});
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => daemon,
      transcripts: { capture },
      logger,
    });
    await invoke(RUNS_IPC.stop, 'run-a1');
    expect(capture).toHaveBeenCalledWith('run-a1');
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(
      daemon.killSession.mock.invocationCallOrder[0],
    );
  });

  it('a daemon that no longer has the session, or no daemon at all, still ends the run in the ledger — and says the daemon did not confirm', async () => {
    const { host, invoke } = fakeHost();
    const ledger = fakeLedger({
      'run-a1': { status: 'blocked' },
      'run-b2': { status: 'interrupted' },
    });
    const daemon = fakeDaemon();
    daemon.cancelTurn.mockRejectedValue(
      new Error('acp.cancelTurn: no such session'),
    );
    daemon.killSession.mockRejectedValue(
      new Error('acp.kill: no such session'),
    );
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => daemon,
      logger,
    });
    await expect(invoke(RUNS_IPC.stop, 'run-a1')).resolves.toMatchObject({
      outcome: 'ledger-only',
      status: 'cancelled',
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);

    const offline = fakeHost();
    registerRunsIpc({
      supervisor: supervisorWith(false),
      host: offline.host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
    });
    await expect(
      offline.invoke(RUNS_IPC.stop, 'run-b2'),
    ).resolves.toMatchObject({
      outcome: 'ledger-only',
    });
    expect(ledger.updateRun).toHaveBeenCalledTimes(2);
  });

  it('leaves an ended run alone and refuses to cancel one waiting on review — without touching the daemon', async () => {
    const { host, invoke } = fakeHost();
    const ledger = fakeLedger({
      'run-d1': { status: 'done' },
      'run-f1': { status: 'failed' },
      'run-r1': { status: 'needs-review' },
    });
    const daemon = fakeDaemon();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => daemon,
      logger,
    });
    await expect(invoke(RUNS_IPC.stop, 'run-d1')).resolves.toEqual({
      outcome: 'already-ended',
      status: 'done',
    });
    await expect(invoke(RUNS_IPC.stop, 'run-f1')).resolves.toEqual({
      outcome: 'already-ended',
      status: 'failed',
    });
    await expect(invoke(RUNS_IPC.stop, 'run-r1')).resolves.toEqual({
      outcome: 'not-stoppable',
      status: 'needs-review',
    });
    expect(daemon.killSession).not.toHaveBeenCalled();
    expect(ledger.updateRun).not.toHaveBeenCalled();
  });

  it('refuses a malformed id and an unknown run before anything else', async () => {
    const { host, invoke } = fakeHost();
    const ledger = fakeLedger({});
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => fakeDaemon(),
      logger,
    });
    await expect(invoke(RUNS_IPC.stop, '../etc')).rejects.toThrow(
      'Not a run id',
    );
    await expect(invoke(RUNS_IPC.stop, 42)).rejects.toThrow('Not a run id');
    await expect(invoke(RUNS_IPC.stop, 'run-nope')).rejects.toThrow(
      'No run run-nope in the ledger.',
    );
  });
});

describe('runs:diff and runs:reveal-worktree', () => {
  it('runs git only in a worktree the ledger names under worktreesDir, and reveals the same path', async () => {
    const { host, invoke } = fakeHost();
    const inside = worktreeOf('run-in1');
    const ledger = fakeLedger({
      'run-in1': { status: 'running', worktreePath: inside, baseRef: 'main' },
      'run-out': {
        status: 'running',
        worktreePath: path.join(os.tmpdir(), 'somewhere-else'),
        baseRef: 'main',
      },
      'run-none': { status: 'queued', worktreePath: null, baseRef: null },
    });
    const git = scriptedGit({
      'merge-base': { stdout: 'abc123\n' },
      numstat: { stdout: '2\t1\tsrc/a.ts\0' },
      status: { stdout: ' M src/a.ts\0' },
      diff: { stdout: 'diff --git a/src/a.ts b/src/a.ts\n' },
    });
    const reveal = jest.fn();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      git,
      reveal,
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
    });

    const diff = await invoke(RUNS_IPC.diff, 'run-in1');
    expect(diff).toEqual({
      comparedTo: 'abc123',
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
      ],
      patch: 'diff --git a/src/a.ts b/src/a.ts\n',
      truncated: false,
    });
    expect(git.mock.calls.every((c) => c[1].cwd === inside)).toBe(true);

    await expect(invoke(RUNS_IPC.diff, 'run-out')).rejects.toThrow(
      /outside .*Refusing/,
    );
    await expect(invoke(RUNS_IPC.diff, 'run-none')).rejects.toThrow(
      'This run has no worktree yet.',
    );

    await invoke(RUNS_IPC.revealWorktree, 'run-in1');
    expect(reveal).toHaveBeenCalledWith(inside);
    await expect(invoke(RUNS_IPC.revealWorktree, 'run-out')).rejects.toThrow(
      /Refusing/,
    );
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

// Customer feedback round 1, finding A: what git says about the worktree
// now, read-only, for the header.
describe('runs:worktree-health', () => {
  function healthHarness(
    rows: Record<string, Partial<AgentRun>>,
    gitAnswers = {},
  ) {
    const { host, invoke } = fakeHost();
    const git = scriptedGit({
      'rev-parse': (args: string[]) =>
        args[1] === '--abbrev-ref'
          ? { stdout: 'feat/x\n' }
          : { stdout: 'true\n' },
      ...gitAnswers,
    });
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger: fakeLedger(rows),
      git,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
    });
    return { invoke, git };
  }

  it('a worktree git can read is ok, with its live branch', async () => {
    const { invoke } = healthHarness({
      'run-h1': {
        status: 'done',
        worktreePath: worktreeOf('run-h1'),
        isolation: 'worktree',
      },
    });
    expect(await invoke(RUNS_IPC.worktreeHealth, 'run-h1')).toEqual({
      kind: 'ok',
      branch: 'feat/x',
    });
  });

  it('a worktree git refuses is orphaned, with git’s own first line as the reason', async () => {
    const { invoke } = healthHarness(
      {
        'run-h2': {
          status: 'done',
          worktreePath: worktreeOf('run-h2'),
          isolation: 'worktree',
        },
      },
      {
        'rev-parse': {
          code: 128,
          stdout: '',
          stderr: 'fatal: not a git repository: /gone/.git/worktrees/run-h2\n',
        },
      },
    );
    expect(await invoke(RUNS_IPC.worktreeHealth, 'run-h2')).toEqual({
      kind: 'orphaned',
      reason: 'fatal: not a git repository: /gone/.git/worktrees/run-h2',
    });
  });

  it('a missing worktree is orphaned; a direct run is unknown, never a git call', async () => {
    const { invoke, git } = healthHarness({
      'run-h3': {
        status: 'done',
        worktreePath: path.join(worktreesDir, 'run-h3-never-made'),
        isolation: 'worktree',
      },
      'run-h4': { status: 'done', cwd: '/tmp/x', isolation: 'directory' },
    });
    expect(await invoke(RUNS_IPC.worktreeHealth, 'run-h3')).toMatchObject({
      kind: 'orphaned',
    });
    expect(await invoke(RUNS_IPC.worktreeHealth, 'run-h4')).toEqual({
      kind: 'unknown',
    });
    expect(git).not.toHaveBeenCalled();
  });
});

// Customer feedback round 1, Fix 8: a finished run's worktree and branch
// used to stay on disk forever.
describe('runs:close-preview and runs:close', () => {
  function closeHarness(
    rows: Record<string, Partial<AgentRun>>,
    gitAnswers = {},
  ) {
    const { host, invoke } = fakeHost();
    const ledger = fakeLedger(rows);
    (
      ledger as unknown as { listTicketProposals: jest.Mock }
    ).listTicketProposals = jest.fn(async () => []);
    const daemon = fakeDaemon();
    (daemon as unknown as { deleteWorktree: jest.Mock }).deleteWorktree =
      jest.fn(async () => {});
    const git = scriptedGit({
      'for-each-ref': { stdout: '' },
      'rev-list': { stdout: '3\n' },
      ...gitAnswers,
    });
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      git,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => daemon,
      logger,
    });
    return { invoke, ledger, daemon, git };
  }

  it('the preview counts the commits a branch deletion would lose — all of them when the branch was never pushed', async () => {
    const inside = worktreeOf('run-close1');
    const { invoke, git } = closeHarness({
      'run-close1': {
        status: 'done',
        worktreePath: inside,
        branch: 'agent/PL-10',
        baseRef: 'main',
        prUrl: null,
        isolation: 'worktree',
      },
    });
    expect(await invoke(RUNS_IPC.closePreview, 'run-close1')).toEqual({
      branch: 'agent/PL-10',
      worktreePath: inside,
      unpushedCommits: 3,
      uncommittedFiles: 0,
      hasPullRequest: false,
      branchWillBeDeleted: true,
    });
    // No remote branch: counted against the base.
    expect(git).toHaveBeenCalledWith(
      ['rev-list', '--count', 'main..HEAD', '--'],
      expect.objectContaining({ cwd: inside }),
    );
  });

  it('a pushed branch counts only what is past the remote; a pull request keeps the branch', async () => {
    const inside = worktreeOf('run-close2');
    const { invoke, git } = closeHarness(
      {
        'run-close2': {
          status: 'needs-review',
          worktreePath: inside,
          branch: 'agent/PL-10',
          baseRef: 'main',
          prUrl: null,
          isolation: 'worktree',
          ticketId: null,
        },
        'run-close3': {
          status: 'done',
          worktreePath: worktreeOf('run-close3'),
          branch: 'agent/PL-11',
          baseRef: 'main',
          prUrl: 'https://github.com/o/r/pull/9',
          isolation: 'worktree',
        },
      },
      {
        'for-each-ref': { stdout: 'refs/remotes/origin/agent/PL-10\n' },
        'rev-list': { stdout: '0\n' },
      },
    );
    expect(await invoke(RUNS_IPC.closePreview, 'run-close2')).toMatchObject({
      unpushedCommits: 0,
      branchWillBeDeleted: true,
    });
    expect(git).toHaveBeenCalledWith(
      ['rev-list', '--count', 'origin/agent/PL-10..HEAD', '--'],
      expect.anything(),
    );
    expect(await invoke(RUNS_IPC.closePreview, 'run-close3')).toMatchObject({
      hasPullRequest: true,
      branchWillBeDeleted: false,
      unpushedCommits: 0,
    });
  });

  it('the preview counts uncommitted files too — the CLOSABLE case where a turn errored with nothing committed (B1, PR #88 review)', async () => {
    // failed/cancelled/interrupted are CLOSABLE, and an agent whose turn
    // errors mid-edit is the normal way a run lands there: eleven files
    // changed, nothing on a commit yet. Before this fix the preview only
    // ever asked git about commits, so it read `unpushedCommits: 0` —
    // "nothing to lose" — for a run that was about to lose everything.
    const inside = worktreeOf('run-closeUncommitted');
    const { invoke, git } = closeHarness(
      {
        'run-closeUncommitted': {
          status: 'failed',
          worktreePath: inside,
          branch: 'agent/PL-12',
          baseRef: 'main',
          prUrl: null,
          isolation: 'worktree',
        },
        // A pull request does not exempt uncommitted work: the PR only
        // reflects what was pushed, so an uncommitted file is still lost
        // when the worktree goes.
        'run-closePrDirty': {
          status: 'done',
          worktreePath: worktreeOf('run-closePrDirty'),
          branch: 'agent/PL-13',
          baseRef: 'main',
          prUrl: 'https://github.com/o/r/pull/12',
          isolation: 'worktree',
        },
      },
      {
        status: {
          stdout: [' M src/a.ts', 'M  src/b.ts', '?? src/new-file.ts', ''].join(
            '\n',
          ),
        },
      },
    );
    expect(
      await invoke(RUNS_IPC.closePreview, 'run-closeUncommitted'),
    ).toMatchObject({
      unpushedCommits: 3,
      uncommittedFiles: 3,
    });
    expect(git).toHaveBeenCalledWith(
      ['status', '--short', '--untracked-files=all', '--'],
      expect.objectContaining({ cwd: inside }),
    );
    expect(
      await invoke(RUNS_IPC.closePreview, 'run-closePrDirty'),
    ).toMatchObject({
      hasPullRequest: true,
      unpushedCommits: 0,
      uncommittedFiles: 3,
    });
  });

  it('a git status failure leaves uncommittedFiles null rather than throwing — the confirm still opens', async () => {
    const { invoke } = closeHarness(
      {
        'run-closeUnreadable': {
          status: 'cancelled',
          worktreePath: worktreeOf('run-closeUnreadable'),
          branch: 'agent/PL-14',
          baseRef: 'main',
          prUrl: null,
          isolation: 'worktree',
        },
      },
      { status: { code: 128, stderr: 'fatal: not a git repository' } },
    );
    expect(
      await invoke(RUNS_IPC.closePreview, 'run-closeUnreadable'),
    ).toMatchObject({ uncommittedFiles: null });
  });

  it('close kills the session first, removes the worktree, and deletes the branch only without a pull request', async () => {
    const { invoke, daemon, ledger } = closeHarness({
      'run-close4': {
        status: 'done',
        worktreePath: worktreeOf('run-close4'),
        branch: 'agent/PL-10',
        baseRef: 'main',
        prUrl: null,
        isolation: 'worktree',
        daemonWorkspaceId: 'run-close4',
      },
      'run-close5': {
        status: 'cancelled',
        worktreePath: worktreeOf('run-close5'),
        branch: 'agent/PL-11',
        baseRef: 'main',
        prUrl: 'https://github.com/o/r/pull/9',
        isolation: 'worktree',
        daemonWorkspaceId: 'run-close5',
      },
    });
    expect(await invoke(RUNS_IPC.close, 'run-close4')).toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
      branchKeptBecause: null,
    });
    expect(daemon.killSession).toHaveBeenCalledWith('run-close4');
    expect(
      (daemon as unknown as { deleteWorktree: jest.Mock }).deleteWorktree,
    ).toHaveBeenCalledWith('run-close4', { deleteBranch: true });
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-close4',
      'worktree_removed',
      expect.objectContaining({ branchDeleted: true }),
    );

    expect(await invoke(RUNS_IPC.close, 'run-close5')).toEqual({
      worktreeRemoved: true,
      branchDeleted: false,
      branchKeptBecause: 'pull-request',
    });
    expect(
      (daemon as unknown as { deleteWorktree: jest.Mock }).deleteWorktree,
    ).toHaveBeenLastCalledWith('run-close5', { deleteBranch: false });
  });

  it('refuses a live run, a direct-folder run, and a run whose proposals are still waiting', async () => {
    const { invoke, ledger, daemon } = closeHarness({
      'run-live': {
        status: 'running',
        worktreePath: worktreeOf('run-live'),
        branch: 'b',
        isolation: 'worktree',
      },
      'run-dir': { status: 'done', cwd: '/tmp/x', isolation: 'directory' },
      'run-rev': {
        status: 'needs-review',
        worktreePath: worktreeOf('run-rev'),
        branch: 'b',
        isolation: 'worktree',
        ticketId: 'wi-1',
      },
    });
    (
      ledger as unknown as { listTicketProposals: jest.Mock }
    ).listTicketProposals.mockResolvedValue([
      { id: 'p1', agentRunId: 'run-rev', status: 'proposed', kind: 'comment' },
    ]);
    await expect(invoke(RUNS_IPC.close, 'run-live')).rejects.toThrow(
      /is running; stop it first/,
    );
    await expect(invoke(RUNS_IPC.close, 'run-dir')).rejects.toThrow(
      /works in your folder directly/,
    );
    await expect(invoke(RUNS_IPC.closePreview, 'run-rev')).rejects.toThrow(
      /A proposal from this run is still waiting in Review/,
    );
    expect(
      (daemon as unknown as { deleteWorktree: jest.Mock }).deleteWorktree,
    ).not.toHaveBeenCalled();
  });

  it('runs:close takes the per-run lock — a resume issued while it is still deleting the worktree queues behind it instead of racing the deletion (B4, PR #88 review)', async () => {
    const inside = worktreeOf('run-closeLock');
    const { invoke, ledger, daemon } = closeHarness({
      'run-closeLock': {
        status: 'failed',
        worktreePath: inside,
        branch: 'agent/PL-15',
        baseRef: 'main',
        prUrl: null,
        isolation: 'worktree',
        daemonWorkspaceId: 'run-closeLock',
      },
    });
    const order: string[] = [];
    // killSession is the first thing close's locked body awaits — held
    // open so a concurrent resume has a real window to race into, the
    // same shape as the bug: a send arriving mid-`resumeRunCore` while
    // close kills the session and deletes the worktree out from under it.
    let releaseKill: () => void = () => {};
    const killGate = new Promise<void>((resolve) => {
      releaseKill = resolve;
    });
    (daemon.killSession as jest.Mock).mockImplementation(async () => {
      order.push('close:kill-start');
      await killGate;
      order.push('close:kill-done');
    });
    // The real daemon actually removes the directory; this harness's
    // default deleteWorktree does not, so a resume racing in here would
    // still find a perfectly usable worktree and prove nothing.
    (daemon as unknown as { deleteWorktree: jest.Mock }).deleteWorktree =
      jest.fn(async () => {
        rmSync(inside, { recursive: true, force: true });
      });
    (daemon as unknown as { listSessions: jest.Mock }).listSessions = jest.fn(
      async () => ({}),
    );
    // Stands in for a real ledger's queryable history: after a genuine
    // close, listEvents would carry the worktree_removed event
    // releaseWorktree appends — resumeRunCore's own closed-run check
    // (startRun.ts's wasClosedByRunsClose) reads exactly this.
    (ledger as unknown as { listEvents: jest.Mock }).listEvents = jest.fn(
      async () => [
        {
          runId: 'run-closeLock',
          seq: 1,
          kind: 'worktree_removed',
          payload: { reason: 'merged', branchDeleted: true },
          at: '2026-09-20T00:00:00.000Z',
        },
      ],
    );

    const closePromise = invoke(RUNS_IPC.close, 'run-closeLock').then((r) => {
      order.push('close:done');
      return r;
    });
    // Issued right after, with no await between: withRunLock registers
    // synchronously (runLock.ts's own doc comment), so this is already
    // queued behind close's lock by the time it would otherwise start.
    const resumePromise = invoke(RUNS_IPC.resume, 'run-closeLock').then((r) => {
      order.push('resume:done');
      return r;
    });

    // Real filesystem awaits (assertUnder's fs.mkdir/fs.realpath, inside
    // closableRun/worktreeOf) resolve through libuv, not a bare
    // microtask — flushing actual event-loop turns, not just
    // Promise.resolve() chains, is what lets close reach killSession.
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    // Only close has started; the resume handler has not run at all yet.
    expect(order).toEqual(['close:kill-start']);
    releaseKill();
    const [closeResult, resumeResult] = await Promise.all([
      closePromise,
      resumePromise,
    ]);
    expect(order).toEqual([
      'close:kill-start',
      'close:kill-done',
      'close:done',
      'resume:done',
    ]);
    expect(closeResult).toMatchObject({ worktreeRemoved: true });
    // Never a silent reprovision: the queued resume sees the worktree
    // genuinely gone (this harness's overridden deleteWorktree actually
    // removed it) AND the worktree_removed event, so it refuses with the
    // clear, permanent `closed` reason rather than cutting a fresh branch
    // of the same name from baseRef.
    expect(resumeResult).toMatchObject({
      outcome: 'cannot-reach-worktree',
      reason: 'closed',
    });
  });
});

describe('assertWorktreeGitDir', () => {
  it('accepts the .git file git worktree add writes, whose gitdir is outside the worktree', async () => {
    const wt = worktreeOf('run-prov1');
    await expect(assertWorktreeGitDir(wt)).resolves.toBeUndefined();
  });

  it('refuses a .git directory, a gitdir inside the worktree, a symlinked .git, and no .git at all', async () => {
    // A planted redirect: the security round's reproduction — .git →
    // ./.evil, whose config could carry a fsmonitor hook.
    const planted = path.join(worktreesDir, 'run-prov2');
    mkdirSync(path.join(planted, '.evil'), { recursive: true });
    writeFileSync(path.join(planted, '.git'), 'gitdir: ./.evil\n');
    await expect(assertWorktreeGitDir(planted)).rejects.toThrow(
      /gitdir is inside the worktree itself/,
    );

    const dir = path.join(worktreesDir, 'run-prov3');
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    await expect(assertWorktreeGitDir(dir)).rejects.toThrow(
      /not a linked worktree/,
    );

    const linked = path.join(worktreesDir, 'run-prov4');
    mkdirSync(linked, { recursive: true });
    symlinkSync(
      path.join(worktreesDir, 'run-prov1', '.git'),
      path.join(linked, '.git'),
    );
    await expect(assertWorktreeGitDir(linked)).rejects.toThrow(
      /not a linked worktree/,
    );

    const bare = path.join(worktreesDir, 'run-prov5');
    mkdirSync(bare, { recursive: true });
    await expect(assertWorktreeGitDir(bare)).rejects.toThrow(/has no .git/);
  });

  it('runs:diff refuses the planted worktree before any git runs', async () => {
    const { host, invoke } = fakeHost();
    const planted = path.join(worktreesDir, 'run-prov6');
    mkdirSync(path.join(planted, '.evil'), { recursive: true });
    writeFileSync(path.join(planted, '.git'), 'gitdir: ./.evil\n');
    const git = scriptedGit({});
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger: fakeLedger({
        'run-prov6': {
          status: 'running',
          worktreePath: planted,
          baseRef: 'main',
        },
      }),
      git,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
    });
    await expect(invoke(RUNS_IPC.diff, 'run-prov6')).rejects.toThrow(
      /Refusing/,
    );
    expect(git).not.toHaveBeenCalled();
  });
});

describe('runs:open-pr', () => {
  /**
   * ROAD-131: unlike stop/diff/reveal, openRunPullRequest used to go
   * straight to the publisher with no worktree-provenance check — the one
   * path here Copilot's own `open_pull_request` tool can reach with no
   * human gate. These reproduce the review's exact finding: a planted
   * worktree (or a directory-isolation run whose folder is gone) must be
   * refused before the publisher — which pushes and opens a real PR, as
   * the person — ever runs.
   */
  it('refuses to publish a worktree-isolation run whose .git is not a real linked worktree, and never calls the publisher', async () => {
    const { host, invoke } = fakeHost();
    const planted = path.join(worktreesDir, 'run-openprplanted');
    mkdirSync(path.join(planted, '.evil'), { recursive: true });
    writeFileSync(path.join(planted, '.git'), 'gitdir: ./.evil\n');
    const publish = jest.fn();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger: {
        ...fakeLedger({
          'run-openprplanted': {
            status: 'needs-review',
            entry: 'dispatched',
            branch: 'agent/road-131',
            worktreePath: planted,
            ticketId: null,
          },
        }),
        claimPublish: jest.fn(async () => {}),
      },
      git: scriptedGit({}),
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
      pullRequests: { publish, publishFollowUp: publish },
    });

    // A refusal is a failed outcome, the same way finalize.ts reports it
    // (round 5 of review: the check moved inside the ticket lock, right
    // before the push — so its answer is an outcome, not a thrown IPC).
    await expect(
      invoke(RUNS_IPC.openPr, 'run-openprplanted'),
    ).resolves.toMatchObject({
      kind: 'failed',
      stage: 'push',
      message: expect.stringMatching(/Refusing/),
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses to publish a directory-isolation run whose folder no longer exists, and never calls the publisher', async () => {
    const { host, invoke } = fakeHost();
    const gone = path.join(worktreesDir, 'run-openprgone-path');
    const publish = jest.fn();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger: {
        ...fakeLedger({
          'run-openprgone': {
            status: 'needs-review',
            entry: 'dispatched',
            branch: 'agent/road-131',
            isolation: 'directory',
            cwd: gone,
            worktreePath: null,
            ticketId: null,
          },
        }),
        claimPublish: jest.fn(async () => {}),
      },
      git: scriptedGit({}),
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
      pullRequests: { publish, publishFollowUp: publish },
    });

    await expect(
      invoke(RUNS_IPC.openPr, 'run-openprgone'),
    ).resolves.toMatchObject({
      kind: 'failed',
      stage: 'push',
      message: expect.stringMatching(/not a folder on this machine any more/),
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes a dispatched run in a genuine linked worktree', async () => {
    const { host, invoke } = fakeHost();
    const legit = worktreeOf('run-openprlegit');
    const publish = jest.fn(async () => ({
      kind: 'opened' as const,
      url: 'https://github.com/acme/widgets/pull/9',
      pushed: true as const,
    }));
    const notify = jest.fn();
    const claimPublish = jest.fn(async () => {});
    const ledger = {
      ...fakeLedger({
        'run-openprlegit': {
          status: 'needs-review',
          entry: 'dispatched',
          branch: 'agent/road-131',
          worktreePath: legit,
          ticketId: null,
          summary: 'Fixed the thing.',
          title: null,
        },
      }),
      postCopilotNote: jest.fn(async () => true),
      claimPublish,
    };
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      git: scriptedGit({}),
      reveal: jest.fn(),
      notify,
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
      // Never-lock: the header goes through publishFollowUp (a run whose
      // PR was merged since gets a new one) after the backend's claim.
      pullRequests: { publish: jest.fn(), publishFollowUp: publish },
    });

    await expect(invoke(RUNS_IPC.openPr, 'run-openprlegit')).resolves.toEqual({
      kind: 'opened',
      url: 'https://github.com/acme/widgets/pull/9',
    });
    expect(claimPublish).toHaveBeenCalledWith('run-openprlegit', null);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("a refused publish claim (another writer holds the ticket) is a skipped outcome carrying the backend's sentence, and never publishes", async () => {
    const { host, invoke } = fakeHost();
    const legit = worktreeOf('run-openprclaim');
    const publishFollowUp = jest.fn();
    const ledger = {
      ...fakeLedger({
        'run-openprclaim': {
          status: 'done',
          entry: 'dispatched',
          branch: 'agent/road-131',
          worktreePath: legit,
          ticketId: null,
        },
      }),
      claimPublish: jest.fn(async () => {
        throw new LedgerRequestError(
          409,
          'Not published: this ticket has a live writer (Other).',
        );
      }),
    };
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      git: scriptedGit({}),
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
      pullRequests: { publish: jest.fn(), publishFollowUp },
    });

    await expect(invoke(RUNS_IPC.openPr, 'run-openprclaim')).resolves.toEqual({
      kind: 'skipped',
      reason: 'Not published: this ticket has a live writer (Other).',
    });
    expect(publishFollowUp).not.toHaveBeenCalled();
  });

  // Found in review, round 4: the header's own claim had the same non-409
  // rethrow finalize.ts's had until round 3 — a timeout or 5xx escaped
  // the ticket lock as a bare IPC rejection, with no trail at all.
  it('a claim that fails for any other reason is a failed outcome with a note on the run — never a rejected IPC call', async () => {
    const { host, invoke } = fakeHost();
    const legit = worktreeOf('run-openprboom');
    const publishFollowUp = jest.fn();
    const ledger = {
      ...fakeLedger({
        'run-openprboom': {
          status: 'done',
          entry: 'dispatched',
          branch: 'agent/road-131',
          worktreePath: legit,
          ticketId: null,
        },
      }),
      claimPublish: jest.fn(async () => {
        throw new Error('ledger request timed out');
      }),
    };
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      git: scriptedGit({}),
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
      pullRequests: { publish: jest.fn(), publishFollowUp },
    });

    await expect(invoke(RUNS_IPC.openPr, 'run-openprboom')).resolves.toEqual({
      kind: 'failed',
      stage: 'push',
      message:
        'Could not claim the publish for this ticket: ledger request timed out',
    });
    expect(publishFollowUp).not.toHaveBeenCalled();
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-openprboom',
      'note',
      expect.objectContaining({ stage: 'open-pr', claim: 'failed' }),
    );
  });

  // Never-lock (found in review): the backend's publish claim only
  // refuses a SECOND run's claim on the same ticket — it does nothing
  // to stop this run's own two concurrent callers, e.g. this button and
  // an in-flight automatic follow-up finalize for the very same run.
  // finalize.ts's own publish already goes under the ticket dispatch
  // lock; the header must take the same one, or the two can push and
  // `gh pr create` for the same run at once.
  it("waits for an in-flight publish on the same ticket before claiming or publishing — never races finalize's own withTicketDispatchLock", async () => {
    const { host, invoke } = fakeHost();
    const legit = worktreeOf('run-openprraced');
    const publish = jest.fn(async () => ({
      kind: 'opened' as const,
      url: 'https://github.com/acme/widgets/pull/11',
      pushed: true as const,
    }));
    const claimPublish = jest.fn(async () => {});
    const ledger = {
      ...fakeLedger({
        'run-openprraced': {
          status: 'needs-review',
          entry: 'dispatched',
          branch: 'agent/road-131',
          worktreePath: legit,
          ticketId: 'ticket-raced',
          summary: 'Fixed the thing.',
          title: null,
        },
      }),
      postCopilotNote: jest.fn(async () => true),
      claimPublish,
      // A real ticketId drives openRunPullRequest through describeRunTicket
      // and the ticket's own proposals — neither exists for this test's
      // ticket, so both come back empty.
      listTicketProposals: jest.fn(async () => []),
      getTicket: jest.fn(async () => null),
      getTicketRef: jest.fn(async () => null),
    };
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      git: scriptedGit({}),
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
      pullRequests: { publish: jest.fn(), publishFollowUp: publish },
    });

    const order: string[] = [];
    claimPublish.mockImplementation(async () => {
      order.push('claim');
    });
    publish.mockImplementation(async () => {
      order.push('publish');
      return {
        kind: 'opened' as const,
        url: 'https://github.com/acme/widgets/pull/11',
        pushed: true as const,
      };
    });

    let releaseFinalize: (() => void) | null = null;
    const finalizeHoldingTheLock = withTicketDispatchLock(
      'ticket-raced',
      async () => {
        order.push('finalize-holds-lock');
        await new Promise<void>((resolve) => {
          releaseFinalize = resolve;
        });
      },
    );

    const openPr = invoke(RUNS_IPC.openPr, 'run-openprraced');
    // The header's call is queued behind finalize's hold — neither the
    // claim nor the publisher has run yet.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(claimPublish).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    releaseFinalize!();
    await finalizeHoldingTheLock;
    await expect(openPr).resolves.toEqual({
      kind: 'opened',
      url: 'https://github.com/acme/widgets/pull/11',
    });
    expect(order).toEqual(['finalize-holds-lock', 'claim', 'publish']);
  });
});

describe('runs:list-pending-prompts', () => {
  it('refuses a malformed id before it ever reaches the ledger (found in review: this handler used to skip the loadRun boundary check every sibling handler goes through)', async () => {
    const { host, invoke } = fakeHost();
    const ledger = fakeLedger({});
    (
      ledger as unknown as { listPendingPrompts: jest.Mock }
    ).listPendingPrompts = jest.fn(async () => []);
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      git: scriptedGit({}),
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
    });

    await expect(
      invoke(RUNS_IPC.listPendingPrompts, 'not-a-run-id; DROP TABLE'),
    ).rejects.toThrow(/Not a run id/);
    expect(
      (ledger as unknown as { listPendingPrompts: jest.Mock })
        .listPendingPrompts,
    ).not.toHaveBeenCalled();
  });

  it('answers with the ledger’s rows for a well-formed id', async () => {
    const { host, invoke } = fakeHost();
    const rows = [{ id: 'pp-1', runId: 'run-listpp01', text: 'hi' }];
    const ledger = fakeLedger({ 'run-listpp01': { status: 'running' } });
    (
      ledger as unknown as { listPendingPrompts: jest.Mock }
    ).listPendingPrompts = jest.fn(async () => rows);
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      git: scriptedGit({}),
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
    });

    await expect(
      invoke(RUNS_IPC.listPendingPrompts, 'run-listpp01'),
    ).resolves.toEqual(rows);
  });
});

describe('execGit hardening', () => {
  it('every call carries the config overrides and a minimal environment', async () => {
    // A real git, in a real (empty) directory: `git --version` is enough
    // to prove the argv shape; the config overrides are inert for it.
    const result = await execGit(['--version'], { cwd: worktreesDir });
    expect(result.code).toBe(0);
    expect(GIT_SAFE_CONFIG).toEqual(
      expect.arrayContaining([
        'core.fsmonitor=false',
        'core.hooksPath=/dev/null',
      ]),
    );
  });

  it('a planted fsmonitor hook does not run under the hardened runner', async () => {
    // The security round's reproduction, against a real git: a repo whose
    // config names a fsmonitor script. Under GIT_SAFE_CONFIG the script
    // must not run.
    const repo = path.join(worktreesDir, 'run-hook1');
    mkdirSync(repo, { recursive: true });
    const marker = path.join(repo, 'MARKER');
    const hook = path.join(repo, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\necho\n`);
    chmodSync(hook, 0o755);
    const init = await execGit(['init', '-q'], { cwd: repo });
    expect(init.code).toBe(0);
    writeFileSync(
      path.join(repo, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${hook}\n`,
      { flag: 'a' },
    );
    // Unhardened, this runs the hook (verified in review). Hardened:
    const status = await execGit(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--'],
      { cwd: repo },
    );
    expect(status.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('computeRunDiff', () => {
  it('compares against the merge-base with the base ref, folds in untracked files, and cuts an oversized patch', async () => {
    const wt = worktreeOf('run-cd1');
    writeFileSync(path.join(wt, 'new.txt'), 'one\ntwo\nthree\n');
    const git = scriptedGit({
      'merge-base': { stdout: 'base999\n' },
      numstat: {
        stdout: '10\t0\tsrc/added.ts\x000\t4\tsrc/gone.ts\x00-\t-\timg.png\x00',
      },
      'name-status': {
        stdout: 'A\x00src/added.ts\x00D\x00src/gone.ts\x00M\x00img.png\x00',
      },
      status: { stdout: '?? new.txt\x00' },
      diff: { stdout: 'x'.repeat(MAX_DIFF_PATCH_CHARS + 10) },
      'no-index': { stdout: '+one\n', code: 1 },
    });

    const diff = await computeRunDiff(git, wt, 'main');
    expect(diff.comparedTo).toBe('base999');
    expect(diff.files).toEqual([
      { path: 'img.png', status: 'modified', additions: 0, deletions: 0 },
      { path: 'new.txt', status: 'untracked', additions: 3, deletions: 0 },
      { path: 'src/added.ts', status: 'added', additions: 10, deletions: 0 },
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 4 },
    ]);
    expect(diff.truncated).toBe(true);
    expect(diff.patch.endsWith('… (patch cut here)\n')).toBe(true);
    expect(diff.patch.length).toBeLessThan(MAX_DIFF_PATCH_CHARS + 40);
    // The base ref reaches git as a positional argument after the
    // subcommand, never somewhere an option could hide.
    expect(git).toHaveBeenCalledWith(['merge-base', 'main', 'HEAD'], {
      cwd: wt,
    });
  });

  it('falls back to HEAD when there is no base ref or git does not know it, and never hands git a ref that looks like an option', async () => {
    const wt = worktreeOf('run-cd2');
    const git = scriptedGit({
      'merge-base': { stdout: '', code: 128 },
      numstat: { stdout: '' },
      status: { stdout: '' },
    });
    expect((await computeRunDiff(git, wt, 'feature/x')).comparedTo).toBe(
      'HEAD',
    );
    expect((await computeRunDiff(git, wt, null)).comparedTo).toBe('HEAD');
    expect((await computeRunDiff(git, wt, '--output=/tmp/x')).comparedTo).toBe(
      'HEAD',
    );
    expect(
      git.mock.calls
        .filter((c) => c[0][0] === 'merge-base')
        .map((c) => c[0][1]),
    ).toEqual(['feature/x']);
  });

  it('lists but neither reads nor patches an untracked file that is not a regular file or is past the size cap, and stops patching past the cut', async () => {
    const wt = worktreeOf('run-cd4');
    writeFileSync(path.join(wt, 'small.txt'), 'a\nb\n');
    writeFileSync(
      path.join(wt, 'big.bin'),
      Buffer.alloc(MAX_UNTRACKED_FILE_BYTES + 1),
    );
    symlinkSync('/dev/zero', path.join(wt, 'zero'));
    const git = scriptedGit({
      'merge-base': { stdout: 'b\n' },
      numstat: { stdout: '' },
      status: { stdout: '?? big.bin\x00?? small.txt\x00?? zero\x00' },
      diff: { stdout: '' },
      'no-index': (args) => ({
        stdout: `+${args[args.length - 1]}\n`,
        code: 1,
      }),
    });
    const diff = await computeRunDiff(git, wt, 'main');
    expect(diff.files).toEqual([
      { path: 'big.bin', status: 'untracked', additions: 0, deletions: 0 },
      { path: 'small.txt', status: 'untracked', additions: 2, deletions: 0 },
      { path: 'zero', status: 'untracked', additions: 0, deletions: 0 },
    ]);
    // Only small.txt was handed to git diff --no-index.
    const noIndex = git.mock.calls.filter((c) => c[0].includes('--no-index'));
    expect(noIndex.map((c) => c[0][c[0].length - 1])).toEqual(['small.txt']);
    expect(diff.patch).toBe('+small.txt\n');
  });

  it('names with spaces, quotes and non-ASCII characters survive: paths travel NUL-separated', async () => {
    const wt = worktreeOf('run-cd5');
    const git = scriptedGit({
      'merge-base': { stdout: 'b\n' },
      numstat: { stdout: '1\t0\tdocs/r\u00e9sum\u00e9 "final".md\x00' },
      'name-status': { stdout: 'M\x00docs/r\u00e9sum\u00e9 "final".md\x00' },
      status: { stdout: ' M docs/r\u00e9sum\u00e9 "final".md\x00' },
      diff: { stdout: '' },
    });
    const diff = await computeRunDiff(git, wt, 'main');
    expect(diff.files.map((f) => f.path)).toEqual([
      'docs/r\u00e9sum\u00e9 "final".md',
    ]);
    expect(diff.files[0].status).toBe('modified');
  });

  it('a failing diff is an error with git’s own sentence', async () => {
    const wt = worktreeOf('run-cd3');
    const git: GitRunner = async (args) =>
      args[0] === 'merge-base'
        ? { stdout: 'b\n', stderr: '', code: 0 }
        : { stdout: '', stderr: 'fatal: not a git repository', code: 128 };
    await expect(computeRunDiff(git, wt, 'main')).rejects.toThrow(
      "git diff failed in the run's worktree: fatal: not a git repository",
    );
  });
});

// W4: the three channels are thin — the sequences themselves are
// runs/startRun.test.ts's. What is proven here is that each channel is
// registered, hands its one argument to the module, and answers with its
// shape; and that `notify` is what a status write reaches the renderer by.
describe('runs:start, runs:resume, runs:list-branches, runs:choose-folder, runs:recent-folders', () => {
  /** A git repository on disk the picker "chose". */
  const repoOnDisk = () => {
    const p = path.join(os.tmpdir(), 'wp-runs-ipc-picked-repo');
    mkdirSync(path.join(p, '.git'), { recursive: true });
    return realpathSync(p);
  };

  it('runs:choose-folder hands back a handle and a description, never the path as the handle; cancel is not an error', async () => {
    const { host, invoke } = fakeHost();
    const picked = repoOnDisk();
    const ledger = {
      ...fakeLedger({}),
      listProjects: jest.fn(async () => [
        { id: 'proj-1', name: 'P', repoPath: picked },
      ]),
    } as unknown as jest.Mocked<LedgerClient>;
    let answer: string | null = null;
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => answer,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => fakeDaemon(),
      logger,
    });
    await expect(invoke(RUNS_IPC.chooseFolder)).resolves.toEqual({
      canceled: true,
    });
    answer = picked;
    const choice = (await invoke(RUNS_IPC.chooseFolder)) as {
      canceled: false;
      folder: {
        handle: string;
        path: string;
        kind: string;
        projectId: string | null;
      };
    };
    expect(choice.canceled).toBe(false);
    expect(choice.folder).toMatchObject({
      path: picked,
      kind: 'repo',
      projectId: 'proj-1',
    });
    expect(choice.folder.handle).toMatch(/^f-/);
    expect(choice.folder.handle).not.toBe(picked);
    // The linked repository is listed among the folders, under the same handle.
    const listed = (await invoke(RUNS_IPC.recentFolders)) as Array<{
      handle: string;
      path: string;
    }>;
    expect(listed.map((f) => f.path)).toEqual([picked]);
    expect(listed[0].handle).toBe(choice.folder.handle);
  });

  it('runs:start refuses a bad request before touching the ledger, and notifies at provisioning', async () => {
    const { host, invoke } = fakeHost();
    const picked = repoOnDisk();
    const ledger = {
      ...fakeLedger({}),
      listProjects: jest.fn(async () => []),
      createRun: jest.fn(async (input: unknown) => ({
        id: 'run-n1',
        status: 'queued',
        ...(input as object),
      })),
    } as unknown as jest.Mocked<LedgerClient>;
    ledger.updateRun.mockImplementation(
      async (id, patch) => ({ id, ...patch }) as never,
    );
    const daemon = {
      ...fakeDaemon(),
      listLocalBranches: jest.fn(async () => ['main']),
      // Never answers: the channel must not wait for the session.
      startSession: jest.fn(() => new Promise(() => {})),
      registerRepository: jest.fn(() => new Promise(() => {})),
    } as unknown as jest.Mocked<DaemonRunsApi>;
    const notify = jest.fn();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify,
      chooseDirectory: async () => picked,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => daemon,
      logger,
    });
    const choice = (await invoke(RUNS_IPC.chooseFolder)) as {
      folder: { handle: string };
    };
    const base = {
      folder: choice.folder.handle,
      ownerMemberId: 'mem-1',
      providerId: 'claude',
      isolation: 'worktree',
      autoApprove: true,
      baseRef: 'main',
    };

    await expect(
      invoke(RUNS_IPC.start, { ...base, providerId: 'gpt' }),
    ).rejects.toThrow(/not one Waypoint can start/);
    await expect(
      invoke(RUNS_IPC.start, { ...base, folder: 'f-forged' }),
    ).rejects.toThrow(/not one this window offered/);
    expect(ledger.createRun).not.toHaveBeenCalled();

    const run = (await invoke(RUNS_IPC.start, {
      ...base,
      firstMessage: 'Try it\nplease',
    })) as { id: string; status: string };
    expect(run).toMatchObject({ id: 'run-n1', status: 'provisioning' });
    expect(ledger.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        isolation: 'worktree',
        autoApprove: true,
        title: 'Try it',
      }),
    );
    expect(notify).toHaveBeenCalledWith({
      runId: 'run-n1',
      status: 'provisioning',
    });
  });

  it('runs:resume answers already-live for a running run without writing', async () => {
    const { host, invoke } = fakeHost();
    const ledger = fakeLedger({ 'run-a1': { status: 'running' } });
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => fakeDaemon(),
      logger,
    });
    await expect(invoke(RUNS_IPC.resume, 'run-a1')).resolves.toEqual({
      outcome: 'already-live',
      status: 'running',
    });
    expect(ledger.updateRun).not.toHaveBeenCalled();
  });

  it('runs:list-branches needs a running engine and answers the sorted list with a suggestion', async () => {
    const picked = repoOnDisk();
    const ledger = {
      ...fakeLedger({}),
      listProjects: jest.fn(async () => []),
    } as unknown as jest.Mocked<LedgerClient>;
    const daemon = {
      ...fakeDaemon(),
      listRefs: jest.fn(async () => ({
        branches: ['main', 'a'],
        remoteHeads: [{ remote: 'origin', branch: 'main' }],
      })),
    } as unknown as jest.Mocked<DaemonRunsApi>;
    const down = fakeHost();
    registerRunsIpc({
      supervisor: supervisorWith(false),
      host: down.host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => picked,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
    });
    const choiceDown = (await down.invoke(RUNS_IPC.chooseFolder)) as {
      folder: { handle: string };
    };
    await expect(
      down.invoke(RUNS_IPC.listBranches, choiceDown.folder.handle),
    ).rejects.toThrow('The agent engine is not running.');

    const live = fakeHost();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host: live.host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => picked,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => daemon,
      logger,
    });
    const choice = (await live.invoke(RUNS_IPC.chooseFolder)) as {
      folder: { handle: string };
    };
    await expect(
      live.invoke(RUNS_IPC.listBranches, choice.folder.handle),
    ).resolves.toEqual({ branches: ['a', 'main'], suggested: 'main' });
  });

  it('runs:diff on a direct run compares the folder against HEAD without the worktree check; a plain folder is refused; reveal opens the folder', async () => {
    const { host, invoke } = fakeHost();
    const picked = repoOnDisk();
    const plain = path.join(os.tmpdir(), 'wp-runs-ipc-plain');
    mkdirSync(plain, { recursive: true });
    const ledger = fakeLedger({
      'run-dir': {
        status: 'running',
        isolation: 'directory',
        cwd: picked,
        worktreePath: null,
        baseRef: null,
      },
      'run-plain': {
        status: 'running',
        isolation: 'directory',
        cwd: realpathSync(plain),
        worktreePath: null,
        baseRef: null,
      },
    });
    const git = scriptedGit({
      numstat: { stdout: '1\t0\tnotes.md\0' },
      'name-status': { stdout: 'M\0notes.md\0' },
      status: { stdout: ' M notes.md\0' },
      diff: { stdout: 'diff --git a/notes.md b/notes.md\n' },
    });
    const reveal = jest.fn();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      git,
      reveal,
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => null,
      logger,
    });
    const diff = (await invoke(RUNS_IPC.diff, 'run-dir')) as {
      comparedTo: string;
      files: Array<{ path: string }>;
    };
    expect(diff.comparedTo).toBe('HEAD');
    expect(diff.files.map((f) => f.path)).toEqual(['notes.md']);
    // No merge-base was asked for: there is no base branch.
    expect(git.mock.calls.some(([args]) => args[0] === 'merge-base')).toBe(
      false,
    );
    expect(git.mock.calls.every(([, opts]) => opts.cwd === picked)).toBe(true);
    await expect(invoke(RUNS_IPC.diff, 'run-plain')).rejects.toThrow(
      /not a git repository, so there are no changes/,
    );
    await invoke(RUNS_IPC.revealWorktree, 'run-dir');
    expect(reveal).toHaveBeenCalledWith(picked);
  });
});

// W5b (docs/design/w5b-jira-dispatch.md §2.7, §2.8): the two channels a
// Jira issue reaches a session through — a typed key resolved in either
// system, and the ledger handle for an issue the drawer already read,
// minted with the site from main's stored credential.
describe('runs:resolve-ticket, runs:jira-ticket-ref', () => {
  const register = (options: {
    ledger: jest.Mocked<LedgerClient>;
    site?: string | null;
  }) => {
    const { host, invoke } = fakeHost();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger: options.ledger,
      reveal: jest.fn(),
      notify: jest.fn(),
      chooseDirectory: async () => null,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      daemon: () => fakeDaemon(),
      ...(options.site === undefined
        ? {}
        : {
            jira: {
              site: () => options.site ?? null,
              getTicket: jest.fn(),
              listComments: jest.fn(),
              listTransitions: jest.fn(),
            },
          }),
      logger,
    });
    return invoke;
  };

  it('runs:resolve-ticket upper-cases the key, refuses a non-key before any request, and passes the ledger’s answer through', async () => {
    const resolved = {
      provider: 'jira' as const,
      id: 'tref-abc1234',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      projectId: 'ENG',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
    };
    const ledger = {
      ...fakeLedger({}),
      resolveTicket: jest.fn(async (key: string) =>
        key === 'ENG-4' ? resolved : null,
      ),
    } as unknown as jest.Mocked<LedgerClient>;
    const invoke = register({ ledger });

    await expect(invoke(RUNS_IPC.resolveTicket, ' eng-4 ')).resolves.toEqual(
      resolved,
    );
    expect(ledger.resolveTicket).toHaveBeenCalledWith('ENG-4');
    await expect(invoke(RUNS_IPC.resolveTicket, 'ENG-9')).resolves.toBeNull();
    await expect(invoke(RUNS_IPC.resolveTicket, '../x')).rejects.toThrow(
      /not a ticket key/,
    );
    await expect(invoke(RUNS_IPC.resolveTicket, 42)).rejects.toThrow(
      /Type a ticket key/,
    );
    expect(ledger.resolveTicket).toHaveBeenCalledTimes(2);
  });

  it('runs:jira-ticket-ref mints the handle with main’s site — never the renderer’s — and refuses without Jira or a key', async () => {
    const ledger = {
      ...fakeLedger({}),
      rememberTicketRef: jest.fn(
        async (input: { site: string; key: string; title: string }) => ({
          id: 'tref-abc1234',
          provider: 'jira',
          site: input.site,
          key: input.key,
          identifier: input.key,
          title: input.title,
          url: `https://${input.site}/browse/${input.key}`,
        }),
      ),
    } as unknown as jest.Mocked<LedgerClient>;
    const invoke = register({ ledger, site: 'yourteam.atlassian.net' });

    await expect(
      invoke(RUNS_IPC.jiraTicketRef, {
        key: 'eng-4',
        title: 'Checkout 500s',
        site: 'evil.example',
      }),
    ).resolves.toEqual({
      ticketId: 'tref-abc1234',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
    });
    expect(ledger.rememberTicketRef).toHaveBeenCalledWith({
      site: 'yourteam.atlassian.net',
      key: 'ENG-4',
      title: 'Checkout 500s',
    });

    await expect(
      invoke(RUNS_IPC.jiraTicketRef, { key: 'nope' }),
    ).rejects.toThrow('Not a Jira issue key.');
    await expect(invoke(RUNS_IPC.jiraTicketRef, null)).rejects.toThrow(
      'Not a Jira issue.',
    );

    const disconnected = register({ ledger, site: null });
    await expect(
      disconnected(RUNS_IPC.jiraTicketRef, { key: 'ENG-4' }),
    ).rejects.toThrow(/Jira is not connected/);
    const noJira = register({ ledger });
    await expect(
      noJira(RUNS_IPC.jiraTicketRef, { key: 'ENG-4' }),
    ).rejects.toThrow(/Jira is not connected/);
    expect(ledger.rememberTicketRef).toHaveBeenCalledTimes(1);
  });
});
