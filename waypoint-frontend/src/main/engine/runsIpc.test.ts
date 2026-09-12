import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { EngineSupervisor } from './supervisor';
import { RUNS_IPC, MAX_DIFF_PATCH_CHARS } from './types';
import type { DaemonRunsApi } from './runs/daemonApi';
import type { AgentRun, LedgerClient } from './runs/ledgerClient';
import { computeRunDiff, registerRunsIpc, type GitRunner } from './runsIpc';

// A real tmp dir: assertUnder realpaths both sides, so a made-up path
// would fail containment for the wrong reason (worktrees.test.ts does the
// same).
const worktreesDir = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), 'wp-runs-ipc-')),
);
const worktreeOf = (runId: string) => {
  const p = path.join(worktreesDir, runId);
  mkdirSync(p, { recursive: true });
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
    | { stdout?: string; code?: number }
    | ((args: string[]) => { stdout?: string; code?: number })
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
    return { stdout: value.stdout ?? '', stderr: '', code: value.code ?? 0 };
  };
  return jest.fn(runner);
}

beforeEach(() => jest.clearAllMocks());

describe('runs:stop', () => {
  it('cancels the turn, kills the session, marks the run cancelled and records the end', async () => {
    const { host, invoke } = fakeHost();
    const ledger = fakeLedger({ 'run-a1': { status: 'running' } });
    const daemon = fakeDaemon();
    registerRunsIpc({
      supervisor: supervisorWith(true),
      host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
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
    });
  });

  it('a daemon that no longer has the session, or no daemon at all, still ends the run in the ledger', async () => {
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
      daemon: () => daemon,
      logger,
    });
    await expect(invoke(RUNS_IPC.stop, 'run-a1')).resolves.toMatchObject({
      outcome: 'stopped',
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);

    const offline = fakeHost();
    registerRunsIpc({
      supervisor: supervisorWith(false),
      host: offline.host,
      worktreesDir,
      ledger,
      reveal: jest.fn(),
      daemon: () => null,
      logger,
    });
    await expect(
      offline.invoke(RUNS_IPC.stop, 'run-b2'),
    ).resolves.toMatchObject({
      outcome: 'stopped',
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
      numstat: { stdout: '2\t1\tsrc/a.ts\n' },
      status: { stdout: ' M src/a.ts\n' },
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

describe('computeRunDiff', () => {
  it('compares against the merge-base with the base ref, folds in untracked files, and cuts an oversized patch', async () => {
    const wt = worktreeOf('run-cd1');
    writeFileSync(path.join(wt, 'new.txt'), 'one\ntwo\nthree\n');
    const git = scriptedGit({
      'merge-base': { stdout: 'base999\n' },
      numstat: {
        stdout: '10\t0\tsrc/added.ts\n0\t4\tsrc/gone.ts\n-\t-\timg.png\n',
      },
      'name-status': {
        stdout: 'A\tsrc/added.ts\nD\tsrc/gone.ts\nM\timg.png\n',
      },
      status: { stdout: '?? new.txt\n' },
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
