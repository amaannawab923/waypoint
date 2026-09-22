import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { EngineSupervisor } from './supervisor';
import {
  MAX_DIFF_PATCH_CHARS,
  RUNS_IPC,
  type FolderChoice,
  type JiraTicketRef,
  type OpenPrResult,
  type ResolvedTicket,
  type RunChanged,
  type CloseRunPreview,
  type CloseRunResult,
  type RunDiff,
  type WorktreeHealth,
  type RunDiffFile,
  type RunDiffFileStatus,
  type SessionFolder,
  type StopRunResult,
} from './types';
import { createDaemonRunsApi, type DaemonRunsApi } from './runs/daemonApi';
import {
  assertRunId,
  createLedgerClient,
  JIRA_ISSUE_KEY,
  LedgerRequestError,
  type AgentRun,
  type LedgerClient,
} from './runs/ledgerClient';
import {
  assertUnder,
  isRefSafeComponent,
  releaseWorktree,
} from './runs/worktrees';
import {
  ENGINE_NOT_RUNNING,
  listRunBranches,
  resumeRun,
  startRun,
} from './runs/startRun';
import {
  buildBriefPreview,
  describeTicketRepo,
  dispatchTicketRun,
  withTicketDispatchLock,
  type TicketRepo,
} from './runs/dispatch';
import { withRunLock } from './runs/runLock';
import {
  deliverPendingAfterFinalize,
  drainIfLive,
  dropPendingPrompt,
  retryPendingPrompt,
  sendRunPrompt,
} from './runs/sendPrompt';
import { warmRun } from './runs/warm';
import {
  describeRunTicket,
  JIRA_NOT_CONNECTED,
  type JiraRunDeps,
} from './runs/jiraRuns';
import type { TranscriptKeeper } from './runs/transcripts';
import type { PullRequestPublisher } from './runs/pullRequests';
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
  /** W6: the publisher `runs:open-pr` retries with. */
  pullRequests?: PullRequestPublisher;
  /** W5b: main's Jira reads and the stored credential's site (runs/jiraRuns.ts); absent = not connected. */
  jira?: JiraRunDeps;
  /** W5b: where main remembers which folder a Jira project's code lives in; defaults to beside the recents file. */
  jiraReposFile?: string;
  /** Ultrafast browser tasks: see DispatchDeps' own comment (dispatch.ts). */
  ultrafastAvailable?: () => boolean;
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

/**
 * The one cwd a run's branch may be pushed from — proven, not assumed.
 * Mirrors exactly what `pullRequests.ts`'s own `publish` derives
 * (`run.worktreePath ?? run.cwd`), so the two can never check a
 * different path than the one git actually runs in (ROAD-131 review,
 * round 2: an earlier version of this gate branched on `run.isolation`
 * instead, which happened to agree with `worktreePath ?? cwd` for every
 * *current* writer but was not the same check). A worktree path is
 * proven under `worktreesDir` and proven a genuine linked worktree
 * (`assertWorktreeGitDir`); a direct run's own folder (no worktree at
 * all) only has to still exist — it is the person's own repository,
 * where the agent already runs.
 */
export async function assertPublishableCwd(
  run: Pick<AgentRun, 'worktreePath' | 'cwd'>,
  worktreesDir: string,
): Promise<string> {
  if (run.worktreePath) {
    await assertUnder(run.worktreePath, worktreesDir);
    await assertWorktreeGitDir(run.worktreePath);
    return run.worktreePath;
  }
  if (!run.cwd) throw new Error('This run has no folder to publish from.');
  const present = await fs
    .stat(run.cwd)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!present) {
    throw new Error(`${run.cwd} is not a folder on this machine any more.`);
  }
  return run.cwd;
}

/** What registration hands back to main: the verbs other modules (Copilot's tools) may call. */
export interface RunsHostApi {
  /** W6: push a run's branch and open its pull request, as the person. */
  openRunPullRequest(runId: string): Promise<OpenPrResult>;
  /** Fix 7: the repository a session on a ticket would use, for Copilot's offer card; null when none is known. */
  describeTicketRepo(ticketId: string): Promise<TicketRepo | null>;
  /** Never-lock: finalize's last step — deliver a message typed while it held the row (sendPrompt.ts). */
  deliverPendingAfterFinalize(runId: string): Promise<void>;
  /**
   * Never-lock: deliver every run's outbox whose session is live — the
   * drain the boot reconcile and app focus trigger (design §2.4). Runs
   * whose session is not live keep their rows for their next resume.
   */
  drainLiveOutboxes(trigger: 'boot' | 'focus'): Promise<void>;
}

export function registerRunsIpc(deps: RunsIpcDeps): RunsHostApi {
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

  /**
   * W6: push the run's branch and open its pull request, as the person.
   * The body is the run's own comment (its closing message), else its
   * summary. Idempotent through the publisher (a PR gh says exists is
   * taken as opened).
   */
  const openRunPullRequest = async (runId: unknown): Promise<OpenPrResult> => {
    const run = await loadRun(runId);
    if (!deps.pullRequests) throw new Error('Publishing is not available.');
    if (run.entry !== 'dispatched' || !run.branch) {
      return { kind: 'skipped', reason: 'This run has no branch to publish.' };
    }
    // ROAD-131: unlike stop/diff/reveal, this path used to run straight
    // to `deps.pullRequests.publish` — which runs git (and, as the
    // person, `gh pr create`) in the run's own cwd — with no check that
    // the cwd is actually what it claims to be. Reachable from Copilot's
    // `open_pull_request` tool with no human in the loop, that is the one
    // path here that most needs the same worktree-provenance gate the
    // read-only diff/reveal handlers already apply before touching git.
    // Proves the exact cwd `publish` itself will use (round 2 of this
    // review: branching on `run.isolation` here checked a *different*
    // path than `worktreePath ?? cwd`, which is what `publish` derives).
    // Proved INSIDE the ticket lock, right before the push — not up here
    // (round 5 of review): the lock can wait behind another publish for
    // minutes, and under never-lock the session that writes to this
    // worktree is still alive the whole time. finalize.ts does the same.
    let closing = run.summary ?? '';
    let title = run.title ?? run.branch;
    let ticketUrl: string | null = null;
    if (run.ticketId) {
      const [proposals, ticket] = await Promise.all([
        ledger.listTicketProposals(run.ticketId).catch(() => []),
        // A native ticket or a Jira issue's handle (W5b).
        describeRunTicket(ledger, run.ticketId),
      ]);
      const comment = proposals.find(
        (p) => p.agentRunId === run.id && p.kind === 'comment',
      );
      if (comment && typeof comment.payload.body === 'string') {
        closing = comment.payload.body;
      }
      if (ticket) {
        title = `${ticket.identifier}: ${ticket.title}`;
        ticketUrl = ticket.url;
      }
    }
    // Never-lock §3.3b: the header's retry takes the same publish claim
    // finalize does — one publisher per ticket — and goes through
    // publishFollowUp, so a run whose PR was merged since gets a new one.
    const claimAndPublish = async (): Promise<OpenPrResult> => {
      try {
        await ledger.claimPublish(run.id, null);
      } catch (error) {
        if (error instanceof LedgerRequestError && error.status === 409) {
          await ledger
            .appendEvent(run.id, 'note', {
              stage: 'open-pr',
              publish: 'skipped',
              claim: 'refused',
              reason: error.message,
            })
            .catch(() => {});
          return { kind: 'skipped', reason: error.message };
        }
        // Found in review (round 4): the same non-409 rethrow finalize.ts's
        // own claim used to have — a timeout or a 5xx here escaped past the
        // ticket lock as a bare IPC rejection, with no trail. A failed
        // outcome instead, exactly like a push that fails.
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn('engine: could not claim the publish', {
          runId: run.id,
          message,
        });
        await ledger
          .appendEvent(run.id, 'note', {
            stage: 'open-pr',
            publish: 'failed',
            claim: 'failed',
            reason: message,
          })
          .catch(() => {});
        return {
          kind: 'failed',
          stage: 'push',
          message: `Could not claim the publish for this ticket: ${message}`,
        };
      }
      try {
        await assertPublishableCwd(run, deps.worktreesDir);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn(
          'engine: refused to publish — cwd provenance check failed',
          { runId: run.id, message },
        );
        return { kind: 'failed', stage: 'push', message };
      }
      return deps.pullRequests!.publishFollowUp({
        run,
        closingMessage: closing,
        title,
        ticketUrl,
      });
    };
    // The publish claim only refuses a SECOND run's claim on the same
    // ticket — it does nothing to stop this run's own two concurrent
    // callers (this button and an in-flight automatic follow-up
    // finalize both racing to publish the same run's report). Same lock
    // finalize's own publish takes (found in review): so the two can
    // never interleave their push/`gh pr create` calls.
    const outcome = run.ticketId
      ? await withTicketDispatchLock(run.ticketId, claimAndPublish)
      : await claimAndPublish();
    if (outcome.kind === 'opened' || outcome.kind === 'updated') {
      deps.notify({ runId: run.id, status: run.status });
      await ledger
        .postCopilotNote(
          run.id,
          `Run ${run.title ?? run.id}: pull request ${outcome.kind} · ${outcome.url}`,
        )
        .catch(() => {});
      return { kind: outcome.kind, url: outcome.url };
    }
    return outcome;
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
    // W5b: a session on a Jira issue reads the issue through main's own
    // client and takes its worktree of the folder remembered for the
    // issue's Jira project.
    ...(deps.jira ? { jira: deps.jira } : {}),
    jiraReposFile:
      deps.jiraReposFile ??
      path.join(path.dirname(deps.recentsFile), 'jira-project-repos.json'),
    ...(deps.ultrafastAvailable
      ? { ultrafastAvailable: deps.ultrafastAvailable }
      : {}),
  };
  deps.host.handle(RUNS_IPC.start, (input) => startRun(startDeps, input));
  // The same per-run lock a send (sendPrompt.ts) and the pane's warm-up
  // (warm.ts) take — see runLock.ts's own doc comment for why every path
  // must share it. A non-string runId skips the lock and goes straight to
  // resumeRun's own validation, which throws the right sentence for it;
  // there's nothing to key a lock on otherwise.
  deps.host.handle(RUNS_IPC.resume, (runId) =>
    typeof runId === 'string'
      ? withRunLock(runId, () => resumeRun(startDeps, runId))
      : resumeRun(startDeps, runId),
  );
  // Never-lock: every send lands somewhere (sendPrompt.ts takes the lock
  // itself, or outboxes without it when the lock is busy).
  deps.host.handle(RUNS_IPC.sendPrompt, (input) =>
    sendRunPrompt(startDeps, input),
  );
  deps.host.handle(RUNS_IPC.warm, (runId) => warmRun(startDeps, runId));
  deps.host.handle(RUNS_IPC.listPendingPrompts, async (runId) => {
    // The same boundary check every sibling single-runId handler goes
    // through `loadRun` for (found in review: this one used its own
    // inline check, format-only — `assertRunId` closes the gap a copy
    // of this handler could otherwise inherit by accident). `async` so
    // that check's throw is a rejection like every sibling's, not a
    // throw from the IPC call itself.
    if (typeof runId !== 'string') throw new Error('Not a run id.');
    assertRunId(runId);
    return ledger.listPendingPrompts(runId);
  });
  deps.host.handle(RUNS_IPC.dropPendingPrompt, (input) =>
    dropPendingPrompt(startDeps, input),
  );
  deps.host.handle(RUNS_IPC.retryPendingPrompt, (input) =>
    retryPendingPrompt(startDeps, input),
  );
  // W5a: a session on a ticket. The renderer names a ticket and a verb;
  // main builds the brief from the ledger and resolves the project's
  // repository itself (runs/dispatch.ts).
  deps.host.handle(RUNS_IPC.briefPreview, (input) =>
    buildBriefPreview(startDeps, input),
  );
  deps.host.handle(RUNS_IPC.dispatch, (input) =>
    dispatchTicketRun(startDeps, input),
  );
  // W6: the retry for a branch finalize could not publish — from the
  // header (runs:open-pr) or from Copilot's open_pull_request tool.
  deps.host.handle(RUNS_IPC.openPr, (runId) => openRunPullRequest(runId));
  // W5b: a typed key to its ticket in either system — the slash commands'
  // door; the backend's dual lookup, with main's Jira credential.
  deps.host.handle(
    RUNS_IPC.resolveTicket,
    async (identifier): Promise<ResolvedTicket | null> => {
      if (typeof identifier !== 'string') throw new Error('Type a ticket key.');
      const key = identifier.trim().toUpperCase();
      if (!JIRA_ISSUE_KEY.test(key)) {
        throw new Error(`${identifier} is not a ticket key (like ROAD-116).`);
      }
      return ledger.resolveTicket(key);
    },
  );
  // W5b: the ledger handle for a Jira issue the renderer read through
  // main's Jira client — the My Jira drawer's Sessions section. The site
  // is the stored credential's; the renderer only names the key.
  deps.host.handle(
    RUNS_IPC.jiraTicketRef,
    async (input): Promise<JiraTicketRef> => {
      if (!input || typeof input !== 'object')
        throw new Error('Not a Jira issue.');
      const raw = input as Record<string, unknown>;
      const key =
        typeof raw.key === 'string' ? raw.key.trim().toUpperCase() : '';
      if (!JIRA_ISSUE_KEY.test(key)) throw new Error('Not a Jira issue key.');
      const title =
        typeof raw.title === 'string' ? raw.title.trim().slice(0, 1000) : '';
      const site = deps.jira?.site() ?? null;
      if (!site) throw new Error(JIRA_NOT_CONNECTED);
      const ref = await ledger.rememberTicketRef({ site, key, title });
      return {
        ticketId: ref.id,
        identifier: ref.identifier,
        title: ref.title,
        url: ref.url,
      };
    },
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

  // Customer feedback round 1, Fix 8: a finished run's worktree and
  // branch used to stay on disk forever. "Close run" removes the worktree
  // (the transcript and diff stay in Waypoint) and the branch, unless a
  // pull request still needs it. Never a branch whose commits exist
  // nowhere else without the person being told so first — hence the
  // preview the confirm is built from.
  const CLOSABLE: ReadonlySet<AgentRun['status']> = new Set([
    'done',
    'needs-review',
    'failed',
    'cancelled',
    'interrupted',
  ]);
  const closableRun = async (runId: unknown): Promise<AgentRun> => {
    const run = await loadRun(runId);
    if (run.isolation === 'directory') {
      throw new Error(
        'This session works in your folder directly; there is no worktree to remove.',
      );
    }
    if (!CLOSABLE.has(run.status)) {
      throw new Error(
        `This run is ${run.status}; stop it first, or wait for it to finish.`,
      );
    }
    if (run.status === 'needs-review' && run.ticketId) {
      const pending = (
        await ledger.listTicketProposals(run.ticketId).catch(() => [])
      ).filter((p) => p.agentRunId === run.id && p.status === 'proposed');
      if (pending.length > 0) {
        throw new Error(
          `${pending.length === 1 ? 'A proposal from this run is' : `${pending.length} proposals from this run are`} still waiting in Review; decide ${pending.length === 1 ? 'it' : 'them'} first.`,
        );
      }
    }
    if (!run.branch) throw new Error('This run has no branch.');
    return run;
  };

  /** Commits on the branch that no remote has — the ones a branch deletion would lose. */
  const unpushedCommits = async (
    run: AgentRun,
    worktree: string,
  ): Promise<number | null> => {
    const branch = run.branch!;
    if (!branch.split('/').every(isRefSafeComponent)) return null;
    const remote = await git(
      ['for-each-ref', '--format=%(refname)', `refs/remotes/origin/${branch}`],
      { cwd: worktree },
    );
    const upstream =
      remote.code === 0 && remote.stdout.trim() ? `origin/${branch}` : null;
    const base =
      upstream ??
      (run.baseRef && run.baseRef.split('/').every(isRefSafeComponent)
        ? run.baseRef
        : null);
    if (!base) return null;
    const count = await git(['rev-list', '--count', `${base}..HEAD`, '--'], {
      cwd: worktree,
    });
    if (count.code !== 0) return null;
    const n = Number.parseInt(count.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  };

  // Finding A (feedback round 1): the header's branch line and Open PR
  // came from the ledger's row alone; a worktree whose parent repository
  // is gone still looked healthy. This asks git, read-only, once per
  // detail open. A directory run has no worktree to check.
  deps.host.handle(
    RUNS_IPC.worktreeHealth,
    async (runId): Promise<WorktreeHealth> => {
      const run = await loadRun(runId);
      if (run.isolation === 'directory' || !run.worktreePath) {
        return { kind: 'unknown' };
      }
      let worktree: string;
      try {
        worktree = await worktreeOf(run);
        await assertWorktreeGitDir(worktree);
      } catch (error) {
        return {
          kind: 'orphaned',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      const probe = await git(['rev-parse', '--is-inside-work-tree'], {
        cwd: worktree,
      }).catch((error: unknown) => ({
        code: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      }));
      if (probe.code !== 0 || probe.stdout.trim() !== 'true') {
        const reason = (probe.stderr || probe.stdout).trim().split('\n')[0];
        return {
          kind: 'orphaned',
          reason: reason || 'git could not read this worktree.',
        };
      }
      const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: worktree,
      }).catch(() => null);
      const branch =
        head && head.code === 0 && head.stdout.trim() !== 'HEAD'
          ? head.stdout.trim()
          : null;
      return { kind: 'ok', branch };
    },
  );

  deps.host.handle(
    RUNS_IPC.closePreview,
    async (runId): Promise<CloseRunPreview> => {
      const run = await closableRun(runId);
      const worktree = await worktreeOf(run);
      await assertWorktreeGitDir(worktree);
      const hasPullRequest = !!run.prUrl;
      return {
        branch: run.branch!,
        worktreePath: worktree,
        unpushedCommits: hasPullRequest
          ? 0
          : await unpushedCommits(run, worktree),
        hasPullRequest,
        branchWillBeDeleted: !hasPullRequest,
      };
    },
  );

  deps.host.handle(RUNS_IPC.close, async (runId): Promise<CloseRunResult> => {
    const run = await closableRun(runId);
    await worktreeOf(run);
    // Never-lock: the daemon may still hold this run's session (a
    // finished run is a conversation that may be continued). It goes
    // first — a session in a folder that is about to be deleted is not
    // one to keep.
    const daemon = daemonFor(deps.supervisor);
    if (!daemon) throw new Error(ENGINE_NOT_RUNNING);
    await deps.transcripts?.capture(run.id);
    await daemon.killSession(run.id).catch((error: unknown) =>
      deps.logger.warn('engine: kill before close did not apply', {
        runId: run.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const keepBranch = !!run.prUrl;
    await releaseWorktree(
      {
        daemon,
        ledger,
        worktreesDir: deps.worktreesDir,
        logger: deps.logger,
      },
      run,
      keepBranch ? 'abandoned' : 'merged',
    );
    deps.logger.info('engine: run closed', {
      runId: run.id,
      branchDeleted: !keepBranch,
    });
    return {
      worktreeRemoved: true,
      branchDeleted: !keepBranch,
      branchKeptBecause: keepBranch ? 'pull-request' : null,
    };
  });

  deps.host.handle(RUNS_IPC.revealWorktree, async (runId): Promise<void> => {
    const run = await loadRun(runId);
    deps.reveal(
      run.isolation === 'directory'
        ? await directoryOf(run)
        : await worktreeOf(run),
    );
  });

  const drainLiveOutboxes = async (
    trigger: 'boot' | 'focus',
  ): Promise<void> => {
    const daemon = daemonFor(deps.supervisor);
    if (!daemon) return;
    const sessions = await daemon.listSessions().catch(() => null);
    if (!sessions) return;
    const runIds = Object.keys(sessions).filter((id) => id.startsWith('run-'));
    await Promise.all(
      runIds.map((runId) =>
        withRunLock(runId, () => drainIfLive(startDeps, runId, trigger)).catch(
          (error: unknown) =>
            deps.logger.warn('engine: outbox drain failed', {
              runId,
              trigger,
              message: error instanceof Error ? error.message : String(error),
            }),
        ),
      ),
    );
  };

  return {
    openRunPullRequest,
    describeTicketRepo: (ticketId) => describeTicketRepo(startDeps, ticketId),
    deliverPendingAfterFinalize: (runId) =>
      deliverPendingAfterFinalize(startDeps, runId),
    drainLiveOutboxes,
  };
}
