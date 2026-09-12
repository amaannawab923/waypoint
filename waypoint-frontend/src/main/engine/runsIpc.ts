import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { EngineSupervisor } from './supervisor';
import {
  MAX_DIFF_PATCH_CHARS,
  RUNS_IPC,
  type RunDiff,
  type RunDiffFile,
  type RunDiffFileStatus,
  type StopRunResult,
} from './types';
import { createDaemonRunsApi, type DaemonRunsApi } from './runs/daemonApi';
import {
  assertRunId,
  createLedgerClient,
  type AgentRun,
  type LedgerClient,
} from './runs/ledgerClient';
import { assertUnder } from './runs/worktrees';

/**
 * The sessions panel's three actions on a run — W3, ROAD-61 (stop) and
 * ROAD-64 (diff), plus revealing the worktree.
 *
 * The renderer sends a run id and nothing else. Main reads the run from
 * the ledger, checks the worktree path it finds there is under
 * `worktreesDir` (worktrees.ts's own rule — a row naming a path outside it
 * is a row someone edited), and only then runs `git` in it or hands it to
 * the OS. Stop goes to the daemon through `createDaemonRunsApi`, the same
 * facade reconcile uses, so `acp.kill` stays a main-side verb (it is not in
 * ALLOWED_PROCEDURES) and the ledger is written in the same place the
 * daemon is told.
 *
 * Dependency-injected like topicsIpc.ts: `host`, `git`, `reveal` and the
 * ledger are handed in so every path is a unit test with fakes; engineIpc.ts
 * wires the real ones.
 */

export interface GitResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed by a signal. */
  code: number | null;
}

export type GitRunner = (
  args: string[],
  options: { cwd: string },
) => Promise<GitResult>;

export interface RunsIpcHost {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
}

export interface RunsIpcDeps {
  supervisor: EngineSupervisor;
  host: RunsIpcHost;
  /** EnginePaths.worktreesDir — the only place a run's worktree may be. */
  worktreesDir: string;
  ledger?: LedgerClient;
  git?: GitRunner;
  /** `shell.showItemInFolder`. */
  reveal: (absolutePath: string) => void;
  /** Test seam: the daemon facade, defaulting to the real one over the live client. */
  daemon?: (supervisor: EngineSupervisor) => DaemonRunsApi | null;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

/** A `git` call is given this long; a diff of a worktree is milliseconds. */
export const GIT_TIMEOUT_MS = 20_000;
/** The most stdout a single `git` call may return (numstat and patch alike). */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** The real runner: `git` from PATH, in `cwd`, never through a shell. */
export const execGit: GitRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && !('code' in error && typeof error.code === 'number')) {
          // Not a non-zero exit: git is missing, or the call timed out.
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code: error ? (error as { code: number }).code : 0,
        });
      },
    );
  });

const TERMINAL: ReadonlySet<AgentRun['status']> = new Set([
  'done',
  'failed',
  'cancelled',
]);

function defaultDaemon(supervisor: EngineSupervisor): DaemonRunsApi | null {
  const client = supervisor.client();
  return client ? createDaemonRunsApi(client) : null;
}

/** `git diff --name-status` letter (A, D, R100, M…) → kind. */
function nameStatusKind(code: string): RunDiffFileStatus {
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  return 'modified';
}

function porcelainStatus(xy: string): RunDiffFileStatus {
  if (xy === '??') return 'untracked';
  if (xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('R')) return 'renamed';
  return 'modified';
}

/** `git diff --numstat` lines → {path: [adds, dels]}; binary files count as 0/0. */
function parseNumstat(stdout: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [adds, dels, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file) continue;
    // A rename is "old => new" or "{a => b}/c" in numstat; the status
    // pass below carries the new name, so key by it.
    const renamed = / => ([^}]+)}?$/.exec(file);
    const key = renamed
      ? file.replace(/\{[^}]* => ([^}]+)\}/, '$1').replace(/^.* => /, '')
      : file;
    out.set(key, [
      adds === '-' ? 0 : Number(adds) || 0,
      dels === '-' ? 0 : Number(dels) || 0,
    ]);
  }
  return out;
}

/**
 * The worktree's changes against the run's base: everything committed on
 * the run's branch since it left `baseRef` (via the merge-base, so the base
 * moving on afterwards does not show up as reverse changes) plus whatever
 * is uncommitted, tracked or not. One file list and one patch.
 */
export async function computeRunDiff(
  git: GitRunner,
  worktreePath: string,
  baseRef: string | null,
): Promise<RunDiff> {
  const run = (args: string[]) => git(args, { cwd: worktreePath });

  // The ledger validates baseRef as a git ref name (agentRuns.schema.ts's
  // gitRefSchema, no leading '-'), but this is the process handing it to
  // git, so it checks too.
  let comparedTo = 'HEAD';
  if (baseRef && !baseRef.startsWith('-')) {
    const mergeBase = await run(['merge-base', baseRef, 'HEAD']);
    if (mergeBase.code === 0 && mergeBase.stdout.trim()) {
      comparedTo = mergeBase.stdout.trim();
    }
  }

  const [numstat, status] = await Promise.all([
    run(['diff', '--numstat', '--find-renames', comparedTo, '--']),
    run(['status', '--porcelain=v1', '--untracked-files=all', '--']),
  ]);
  if (numstat.code !== 0) {
    throw new Error(
      `git diff failed in the run's worktree: ${numstat.stderr.trim() || `exit ${numstat.code}`}`,
    );
  }
  const counts = parseNumstat(numstat.stdout);

  // Status decides each file's kind: the numstat pass alone cannot tell an
  // untracked file (absent from it) from an unchanged one, and a file
  // deleted on the branch is in numstat but not in status.
  const statusByPath = new Map<string, RunDiffFileStatus>();
  const untracked: string[] = [];
  for (const line of status.stdout.split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let file = line.slice(3);
    const arrow = file.indexOf(' -> ');
    if (arrow !== -1) file = file.slice(arrow + 4);
    const kind = porcelainStatus(xy);
    statusByPath.set(file, kind);
    if (kind === 'untracked') untracked.push(file);
  }

  // Committed-only changes are in numstat but not in status: ask git what
  // happened to each of those.
  const nameStatus = await run([
    'diff',
    '--name-status',
    '--find-renames',
    comparedTo,
    '--',
  ]);
  const committedKind = new Map<string, RunDiffFileStatus>();
  for (const line of nameStatus.stdout.split('\n')) {
    if (!line) continue;
    const [code, ...rest] = line.split('\t');
    const file = rest[rest.length - 1];
    if (!file) continue;
    committedKind.set(file, nameStatusKind(code));
  }

  const files: RunDiffFile[] = [];
  const seen = new Set<string>();
  for (const [file, [additions, deletions]] of counts) {
    seen.add(file);
    files.push({
      path: file,
      status: statusByPath.get(file) ?? committedKind.get(file) ?? 'modified',
      additions,
      deletions,
    });
  }
  for (const file of untracked) {
    if (seen.has(file)) continue;
    let additions = 0;
    try {
      const text = await fs.readFile(path.join(worktreePath, file), 'utf8');
      additions = text.length === 0 ? 0 : text.split('\n').length;
    } catch {
      // Unreadable (a socket, gone already): listed, counted as 0.
    }
    files.push({ path: file, status: 'untracked', additions, deletions: 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  // One patch: tracked changes against the base, then each untracked file
  // as a diff against nothing (--no-index exits 1 when there is a diff,
  // which is the expected answer, not a failure).
  const parts: string[] = [];
  const tracked = await run(['diff', '--find-renames', comparedTo, '--']);
  if (tracked.stdout) parts.push(tracked.stdout);
  for (const file of untracked) {
    const one = await run(['diff', '--no-index', '--', '/dev/null', file]);
    if (one.stdout) parts.push(one.stdout);
  }
  let patch = parts.join('');
  let truncated = false;
  if (patch.length > MAX_DIFF_PATCH_CHARS) {
    patch = `${patch.slice(0, MAX_DIFF_PATCH_CHARS)}\n… (patch cut here)\n`;
    truncated = true;
  }

  return { comparedTo, files, patch, truncated };
}

export function registerRunsIpc(deps: RunsIpcDeps): void {
  const ledger = deps.ledger ?? createLedgerClient();
  const git = deps.git ?? execGit;
  const daemonFor = deps.daemon ?? defaultDaemon;

  const loadRun = async (runId: unknown): Promise<AgentRun> => {
    if (typeof runId !== 'string') throw new Error('Not a run id.');
    assertRunId(runId);
    const run = await ledger.getRun(runId);
    if (!run) throw new Error(`No run ${runId} in the ledger.`);
    return run;
  };

  /** The run's worktree, proven to be under worktreesDir. */
  const worktreeOf = async (run: AgentRun): Promise<string> => {
    if (!run.worktreePath) {
      throw new Error('This run has no worktree yet.');
    }
    await assertUnder(run.worktreePath, deps.worktreesDir);
    return run.worktreePath;
  };

  deps.host.handle(RUNS_IPC.stop, async (runId): Promise<StopRunResult> => {
    const run = await loadRun(runId);
    if (TERMINAL.has(run.status)) {
      return { outcome: 'already-ended', status: run.status };
    }
    if (run.status === 'needs-review') {
      return { outcome: 'not-stoppable', status: run.status };
    }

    // Tell the daemon first, then the ledger — the daemon is where the
    // agent actually is. Either daemon step failing is not a reason to
    // leave the run live: a session the daemon no longer has is exactly
    // what the user is asking for, and reconcile (ROAD-57) will not revive
    // a cancelled run.
    const daemon = daemonFor(deps.supervisor);
    if (daemon) {
      await daemon.cancelTurn(run.id).catch((error: unknown) =>
        deps.logger.warn('engine: cancelTurn before stop did not apply', {
          runId: run.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await daemon.killSession(run.id).catch((error: unknown) =>
        deps.logger.warn('engine: kill on stop did not apply', {
          runId: run.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } else {
      deps.logger.info('engine: stop with no daemon connection; ledger only', {
        runId: run.id,
      });
    }
    const updated = await ledger.updateRun(run.id, {
      status: 'cancelled',
      reason: 'Stopped from the sessions panel',
    });
    await ledger
      .appendEvent(run.id, 'session_ended', { reason: 'stopped' })
      .catch(() => {});
    deps.logger.info('engine: run stopped', { runId: run.id });
    return { outcome: 'stopped', status: updated.status };
  });

  deps.host.handle(RUNS_IPC.diff, async (runId): Promise<RunDiff> => {
    const run = await loadRun(runId);
    const worktree = await worktreeOf(run);
    return computeRunDiff(git, worktree, run.baseRef);
  });

  deps.host.handle(RUNS_IPC.revealWorktree, async (runId): Promise<void> => {
    const run = await loadRun(runId);
    const worktree = await worktreeOf(run);
    deps.reveal(worktree);
  });
}
