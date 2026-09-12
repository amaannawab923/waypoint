import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { EngineSupervisor } from './supervisor';
import {
  MAX_DIFF_PATCH_CHARS,
  RUNS_IPC,
  type FolderChoice,
  type RunChanged,
  type RunDiff,
  type RunDiffFile,
  type RunDiffFileStatus,
  type SessionFolder,
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
import { listRunBranches, resumeRun, startRun } from './runs/startRun';
import { buildBriefPreview, dispatchTicketRun } from './runs/dispatch';
import type { TranscriptKeeper } from './runs/transcripts';
import {
  createFolderRegistry,
  describeFolder,
  isGitRepository,
  listSessionFolders,
  type FolderDeps,
  type FolderRegistry,
} from './runs/folders';

/**
 * The sessions panel's actions on a run — W3, ROAD-61 (stop) and ROAD-64
 * (diff), plus revealing the worktree; W4 adds start, resume and the
 * branch list the New session dialog needs (runs/startRun.ts).
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
  /** `runs:changed` to the renderer — start and resume write statuses the panel must hear about. */
  notify: (change: RunChanged) => void;
  /**
   * The OS folder picker, parented to the window: the chosen absolute
   * path, or null when cancelled (W4b). Only main ever sees the path.
   */
  chooseDirectory: () => Promise<string | null>;
  /** Where main keeps the recent folders (`recent-folders.json`). */
  recentsFile: string;
  /** Test seam: the handle registry, defaulting to a fresh one per registration. */
  folderRegistry?: FolderRegistry;
  /** Test seam: the daemon facade, defaulting to the real one over the live client. */
  daemon?: (supervisor: EngineSupervisor) => DaemonRunsApi | null;
  /** The transcript snapshot Stop takes before the kill (ROAD-124). */
  transcripts?: TranscriptKeeper;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

/** A `git` call is given this long; a diff of a worktree is milliseconds. */
export const GIT_TIMEOUT_MS = 20_000;
/** The most stdout a single `git` call may return (numstat and patch alike). */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Config git must not take from the repository — the worktree is a
 * directory the agent writes to, and repo-local config can turn a plain
 * `git status` into a code path (found in review, security round 1:
 * `core.fsmonitor` pointing at a script in the worktree ran it). Every
 * call carries these `-c` overrides, on top of the per-command flags
 * below (`--no-ext-diff --no-textconv --ignore-submodules=all`) and the
 * gitdir provenance check in `assertWorktreeGitDir`.
 */
export const GIT_SAFE_CONFIG: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'core.sshCommand=',
  '-c',
  'core.pager=cat',
];

/** The real runner: `git` from PATH, in `cwd`, never through a shell, with a minimal environment. */
export const execGit: GitRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_SAFE_CONFIG, ...args],
      {
        cwd: options.cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          LANG: 'C.UTF-8',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
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

/** `git diff --numstat -z` records → {path: [adds, dels]}; binary files count as 0/0. */
function parseNumstat(stdout: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  // With -z each record is "adds\tdels\tpath\0"; a rename is
  // "adds\tdels\0old\0new\0". Walk the NUL-separated fields.
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const [adds, dels, inline] = field.split('\t');
    if (adds === undefined || dels === undefined) continue;
    let file = inline;
    if (!file) {
      // A rename: the next two fields are old, then new.
      i += 2;
      file = fields[i];
    }
    if (!file) continue;
    out.set(file, [
      adds === '-' ? 0 : Number(adds) || 0,
      dels === '-' ? 0 : Number(dels) || 0,
    ]);
  }
  return out;
}

/** `git status --porcelain=v1 -z` → {path: kind}, renames keyed by the new name. */
function parseStatusZ(stdout: string): Map<string, RunDiffFileStatus> {
  const out = new Map<string, RunDiffFileStatus>();
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    const file = field.slice(3);
    // A rename/copy record is "XY new\0old\0": skip the old name.
    if (xy.includes('R') || xy.includes('C')) i += 1;
    out.set(file, porcelainStatus(xy));
  }
  return out;
}

/** `git diff --name-status -z` → {path: kind}. */
function parseNameStatusZ(stdout: string): Map<string, RunDiffFileStatus> {
  const out = new Map<string, RunDiffFileStatus>();
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const code = fields[i];
    if (!code) continue;
    i += 1;
    let file = fields[i];
    if (code.startsWith('R') || code.startsWith('C')) {
      i += 1;
      file = fields[i];
    }
    if (file) out.set(file, nameStatusKind(code));
  }
  return out;
}

/** An untracked file larger than this is listed but neither counted nor patched. */
export const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
/** More untracked files than this are listed, but only this many get a patch. */
export const MAX_UNTRACKED_PATCHED = 200;

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--find-renames'];

/**
 * The worktree's changes against the run's base: everything committed on
 * the run's branch since it left `baseRef` (via the merge-base, so the base
 * moving on afterwards does not show up as reverse changes) plus whatever
 * is uncommitted, tracked or not. One file list and one patch. Every git
 * call is bounded (GIT_TIMEOUT_MS, GIT_MAX_BUFFER); untracked files are
 * read only when they are regular files under MAX_UNTRACKED_FILE_BYTES,
 * and the patch stops growing once past MAX_DIFF_PATCH_CHARS, so a
 * worktree full of build output cannot pin main (security round 1).
 * Paths travel NUL-separated (-z), so a name with a quote or a non-ASCII
 * character is the name, not git's C-quoted rendering of it.
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
    run(['diff', '--numstat', '-z', ...DIFF_FLAGS, comparedTo, '--']),
    run([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all',
      '--',
    ]),
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
  const statusByPath = parseStatusZ(status.stdout);
  const untracked = [...statusByPath.entries()]
    .filter(([, kind]) => kind === 'untracked')
    .map(([file]) => file);

  // Committed-only changes are in numstat but not in status: ask git what
  // happened to each of those.
  const nameStatus = await run([
    'diff',
    '--name-status',
    '-z',
    ...DIFF_FLAGS,
    comparedTo,
    '--',
  ]);
  const committedKind = parseNameStatusZ(nameStatus.stdout);

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
  // Untracked files worth a patch: regular, under the size cap, and among
  // the first MAX_UNTRACKED_PATCHED. Anything else is listed and left.
  const patchable: string[] = [];
  for (const file of untracked) {
    if (seen.has(file)) continue;
    let additions = 0;
    try {
      const stat = await fs.lstat(path.join(worktreePath, file));
      if (
        stat.isFile() &&
        stat.size <= MAX_UNTRACKED_FILE_BYTES &&
        patchable.length < MAX_UNTRACKED_PATCHED
      ) {
        const text = await fs.readFile(path.join(worktreePath, file), 'utf8');
        // Lines, the way git counts them: a trailing newline ends the last
        // line rather than starting an empty one.
        additions =
          text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length;
        patchable.push(file);
      }
    } catch {
      // Gone already, or not readable: listed, counted as 0.
    }
    files.push({ path: file, status: 'untracked', additions, deletions: 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  // One patch: tracked changes against the base, then each patchable
  // untracked file as a diff against nothing (--no-index exits 1 when
  // there is a diff, which is the expected answer, not a failure). Assembly
  // stops once the cap is passed rather than diffing files nobody will see.
  const parts: string[] = [];
  let length = 0;
  let truncated = false;
  const tracked = await run(['diff', ...DIFF_FLAGS, comparedTo, '--']);
  if (tracked.stdout) {
    parts.push(tracked.stdout);
    length += tracked.stdout.length;
  }
  for (const file of patchable) {
    if (length > MAX_DIFF_PATCH_CHARS) {
      truncated = true;
      break;
    }
    const one = await run([
      'diff',
      '--no-index',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      '/dev/null',
      file,
    ]);
    if (one.stdout) {
      parts.push(one.stdout);
      length += one.stdout.length;
    }
  }
  let patch = parts.join('');
  if (patch.length > MAX_DIFF_PATCH_CHARS) {
    patch = `${patch.slice(0, MAX_DIFF_PATCH_CHARS)}\n… (patch cut here)\n`;
    truncated = true;
  }

  return { comparedTo, files, patch, truncated };
}

/**
 * The worktree's `.git` must be the plain file `git worktree add` writes,
 * whose `gitdir:` points OUTSIDE the worktree — the main repository's
 * `.git/worktrees/<name>`, which the agent's cwd-scoped writes cannot
 * reach. A `.git` directory, a symlink, or a gitdir inside the worktree
 * means repo-local config the agent can edit (found in review, security
 * round 1: `.git` → `gitdir: ./.evil`, `.evil/config` with a fsmonitor
 * hook, executed by `git status`). Refused, with the sentence the pane
 * shows.
 */
export async function assertWorktreeGitDir(
  worktreePath: string,
): Promise<void> {
  const dotGit = path.join(worktreePath, '.git');
  let stat;
  try {
    stat = await fs.lstat(dotGit);
  } catch {
    throw new Error('This worktree has no .git; nothing to diff.');
  }
  if (!stat.isFile()) {
    throw new Error(
      'This worktree is not a linked worktree (its .git is not the file git worktree add writes). Refusing to run git in it.',
    );
  }
  const content = await fs.readFile(dotGit, 'utf8');
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) {
    throw new Error(
      "This worktree's .git file names no gitdir. Refusing to run git in it.",
    );
  }
  const gitdir = path.resolve(worktreePath, match[1]);
  const realWorktree = await fs.realpath(worktreePath);
  const realGitdir = await fs.realpath(gitdir).catch(() => gitdir);
  const rel = path.relative(realWorktree, realGitdir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(
      "This worktree's gitdir is inside the worktree itself, where the agent writes. Refusing to run git in it.",
    );
  }
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

  const folders: FolderDeps = {
    registry: deps.folderRegistry ?? createFolderRegistry(),
    recentsFile: deps.recentsFile,
    listProjects: () => ledger.listProjects(),
  };
  const startDeps = {
    ledger,
    daemon: () => daemonFor(deps.supervisor),
    worktreesDir: deps.worktreesDir,
    notify: deps.notify,
    git,
    assertWorktreeGitDir,
    folders,
    logger: deps.logger,
  };
  deps.host.handle(RUNS_IPC.start, (input) => startRun(startDeps, input));
  deps.host.handle(RUNS_IPC.resume, (runId) => resumeRun(startDeps, runId));
  // W5a: a session on a ticket. The renderer names a ticket and a verb;
  // main builds the brief from the ledger and resolves the project's
  // repository itself (runs/dispatch.ts).
  deps.host.handle(RUNS_IPC.briefPreview, (input) =>
    buildBriefPreview(startDeps, input),
  );
  deps.host.handle(RUNS_IPC.dispatch, (input) =>
    dispatchTicketRun(startDeps, input),
  );
  deps.host.handle(RUNS_IPC.listBranches, (folder) =>
    listRunBranches(startDeps, folder),
  );
  // W4b: the folders a session may start in. The picker's path never
  // leaves main; the renderer gets a handle and a description.
  deps.host.handle(RUNS_IPC.chooseFolder, async (): Promise<FolderChoice> => {
    const chosen = await deps.chooseDirectory();
    if (!chosen) return { canceled: true };
    const folder = await describeFolder(folders, chosen);
    if (!folder) throw new Error('That is not a folder on this machine.');
    return { canceled: false, folder };
  });
  deps.host.handle(RUNS_IPC.recentFolders, (): Promise<SessionFolder[]> =>
    listSessionFolders(folders),
  );
  deps.host.handle(RUNS_IPC.homeDir, (): string => os.homedir());

  deps.host.handle(RUNS_IPC.stop, async (runId): Promise<StopRunResult> => {
    const run = await loadRun(runId);
    if (TERMINAL.has(run.status)) {
      return { outcome: 'already-ended', status: run.status };
    }
    if (run.status === 'needs-review') {
      return { outcome: 'not-stoppable', status: run.status };
    }

    // The ledger first, then the daemon (found in review: the other way
    // round, cancelling the turn dropped the pending permission, the live
    // follower saw a blocked run with nothing pending and wrote
    // "running / permission answered" before `cancelled` landed). With
    // `cancelled` written first the follower's fresh read sees a run that
    // is over and leaves it alone. A daemon step failing is not a reason
    // to leave the run live — but it is reported: the ledger says
    // cancelled while the daemon may still hold the session.
    const updated = await ledger.updateRun(run.id, {
      status: 'cancelled',
      reason: 'Stopped from the sessions panel',
    });
    const daemon = daemonFor(deps.supervisor);
    let daemonConfirmed = false;
    if (daemon) {
      // The transcript before the kill (ROAD-124): what the agent did up
      // to the stop stays readable.
      await deps.transcripts?.capture(run.id);
      await daemon.cancelTurn(run.id).catch((error: unknown) =>
        deps.logger.warn('engine: cancelTurn before stop did not apply', {
          runId: run.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      daemonConfirmed = await daemon
        .killSession(run.id)
        .then(() => true)
        .catch((error: unknown) => {
          deps.logger.warn('engine: kill on stop did not apply', {
            runId: run.id,
            message: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
    } else {
      deps.logger.info('engine: stop with no daemon connection; ledger only', {
        runId: run.id,
      });
    }
    await ledger
      .appendEvent(run.id, 'session_ended', {
        reason: 'stopped',
        daemonConfirmed,
      })
      .catch(() => {});
    deps.logger.info('engine: run stopped', {
      runId: run.id,
      daemonConfirmed,
    });
    return {
      outcome: daemonConfirmed ? 'stopped' : 'ledger-only',
      status: updated.status,
    };
  });

  /**
   * A direct run's cwd is the folder the person picked (W4b): it only has
   * to still be a directory. It is the person's own repository, where the
   * agent already runs, so the worktree provenance check does not apply
   * — the hardened git config and minimal env do.
   */
  const directoryOf = async (run: AgentRun): Promise<string> => {
    if (!run.cwd) throw new Error('This run has no folder.');
    const present = await fs
      .stat(run.cwd)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!present) {
      throw new Error(`${run.cwd} is not a folder on this machine any more.`);
    }
    return run.cwd;
  };

  deps.host.handle(RUNS_IPC.diff, async (runId): Promise<RunDiff> => {
    const run = await loadRun(runId);
    if (run.isolation === 'directory') {
      const dir = await directoryOf(run);
      if (!(await isGitRepository(dir))) {
        throw new Error(
          'This folder is not a git repository, so there are no changes to show.',
        );
      }
      // No base branch: the working tree against HEAD.
      return computeRunDiff(git, dir, null);
    }
    const worktree = await worktreeOf(run);
    await assertWorktreeGitDir(worktree);
    return computeRunDiff(git, worktree, run.baseRef);
  });

  deps.host.handle(RUNS_IPC.revealWorktree, async (runId): Promise<void> => {
    const run = await loadRun(runId);
    deps.reveal(
      run.isolation === 'directory'
        ? await directoryOf(run)
        : await worktreeOf(run),
    );
  });
}
