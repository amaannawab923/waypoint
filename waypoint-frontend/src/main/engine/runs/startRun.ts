import { promises as fs } from 'node:fs';
import {
  AUTO_APPROVE_MODE_ID,
  MAX_FIRST_MESSAGE_CHARS,
  MAX_RUN_TITLE_CHARS,
  SUPPORTED_PROVIDERS,
  type ResumeRunResult,
  type RunBranches,
  type RunChanged,
  type RunIsolation,
  type StartRunInput,
} from '../types';
import type { DaemonRunsApi } from './daemonApi';
import { describeFolder, rememberFolder, type FolderDeps } from './folders';
import { assertRunId, type AgentRun, type LedgerClient } from './ledgerClient';
import {
  assertUnder,
  isRefSafeComponent,
  provisionWorktree,
} from './worktrees';

/**
 * Starting and resuming an independent session — W4, ROAD-67 and ROAD-69
 * (docs/design/w4-start-session.md §3).
 *
 * One place a run is born. The renderer names a project, a provider, a
 * base branch and maybe a title; main resolves the project's linked
 * repository from the backend, writes the ledger row, provisions the
 * worktree through W2's `provisionWorktree`, starts the ACP session and
 * records each step. `startRun` answers the moment the row is
 * `provisioning` — that is what puts the run in the list within a second —
 * and `continueStart` carries on in main with the row as its only state:
 * it re-reads the run before the session is started and again before the
 * ledger hears about it, so a Stop that landed in between (W3 writes
 * `cancelled` first) is honoured — the session is not started, or is
 * killed, and the worktree stays as evidence (W2's rule for a crash).
 *
 * W4b (ROAD-116): the renderer names a folder *handle*, never a path; main
 * resolves it (folders.ts), decides the run's project from the folder,
 * and either provisions a worktree of it or runs the agent in it
 * directly. Auto-approve is the provider's bypass-permissions mode at
 * start; the dialog's first message rides in as the session's initial
 * queue and names the run.
 *
 * Resume is `acp.start` with the provider's own session id handed back.
 * The daemon loads the session and, when the provider cannot, starts a
 * fresh one in the same cwd and answers a new id — the outcome is read
 * off that comparison, and only the fresh-session case gets Waypoint's
 * branch-state note as its first message.
 */

export interface StartRunLogger {
  info: (m: string, meta?: Record<string, unknown>) => void;
  warn: (m: string, meta?: Record<string, unknown>) => void;
}

/** A bounded, hardened `git` — runsIpc.ts's `execGit` (GIT_SAFE_CONFIG). */
export type NoteGitRunner = (
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; code: number | null }>;

export interface StartRunDeps {
  ledger: LedgerClient;
  /** The daemon facade over the live client, or null while the engine is not running. */
  daemon: () => DaemonRunsApi | null;
  /** EnginePaths.worktreesDir — where every run's worktree lives. */
  worktreesDir: string;
  /** `runs:changed` to the renderer, after every status this module writes. */
  notify: (change: RunChanged) => void;
  /** For the resume note's `git log` / `git status` in the run's worktree. */
  git: NoteGitRunner;
  /** runsIpc.ts's check that the worktree's `.git` is a linked-worktree file. */
  assertWorktreeGitDir: (worktreePath: string) => Promise<void>;
  /** The folder handles this process minted, and the recents file (W4b). */
  folders: FolderDeps;
  logger: StartRunLogger;
}

export const ENGINE_NOT_RUNNING = 'The agent engine is not running.';

// What the ledger accepts (validation/agentRuns.schema.ts): the same clip
// worktrees.ts applies, for the same reason — a cut sentence beats a 400.
const MAX_ERROR_MESSAGE = 4000;
const MAX_EVENT_MESSAGE = 12_000;
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A validated start request: the folder is still a handle here. */
export interface ValidatedStartInput {
  folder: string;
  ownerMemberId: string;
  providerId: StartRunInput['providerId'];
  isolation: RunIsolation;
  autoApprove: boolean;
  baseRef: string | null;
  firstMessage: string | null;
  /** The first message's first line, clipped — the run's name. */
  title: string | null;
}

/** The first non-empty line, clipped to a title. */
export function titleFromMessage(message: string): string | null {
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length <= MAX_RUN_TITLE_CHARS
    ? line
    : `${line.slice(0, MAX_RUN_TITLE_CHARS - 1)}…`;
}

/** The input as the renderer sent it, checked field by field. Throws with the sentence to show. */
export function validateStartInput(input: unknown): ValidatedStartInput {
  if (!input || typeof input !== 'object')
    throw new Error('Not a start request.');
  const raw = input as Record<string, unknown>;
  const {
    folder,
    ownerMemberId,
    providerId,
    isolation,
    autoApprove,
    baseRef,
    firstMessage,
  } = raw;
  if (typeof folder !== 'string' || folder.length === 0)
    throw new Error('Choose a folder.');
  if (typeof ownerMemberId !== 'string') throw new Error('No current member.');
  assertRunId(ownerMemberId);
  if (
    typeof providerId !== 'string' ||
    !(SUPPORTED_PROVIDERS as readonly string[]).includes(providerId)
  ) {
    throw new Error(
      `Provider ${JSON.stringify(providerId)} is not one Waypoint can start a session on.`,
    );
  }
  if (isolation !== 'worktree' && isolation !== 'directory') {
    throw new Error('Choose where the agent should work.');
  }
  if (typeof autoApprove !== 'boolean') {
    throw new Error('Say whether the agent may work without asking.');
  }
  let cleanBase: string | null = null;
  if (isolation === 'worktree') {
    if (
      typeof baseRef !== 'string' ||
      baseRef.length === 0 ||
      !baseRef.split('/').every(isRefSafeComponent)
    ) {
      throw new Error('Choose a base branch.');
    }
    cleanBase = baseRef;
  }
  let cleanMessage: string | null = null;
  if (firstMessage !== undefined && firstMessage !== null) {
    if (typeof firstMessage !== 'string')
      throw new Error('The first message must be text.');
    cleanMessage = firstMessage.trim();
    if (cleanMessage.length === 0) cleanMessage = null;
    else if (cleanMessage.length > MAX_FIRST_MESSAGE_CHARS) {
      throw new Error(
        `The first message can be at most ${MAX_FIRST_MESSAGE_CHARS} characters.`,
      );
    }
  }
  return {
    folder,
    ownerMemberId,
    providerId: providerId as StartRunInput['providerId'],
    isolation,
    autoApprove,
    baseRef: cleanBase,
    firstMessage: cleanMessage,
    title: cleanMessage ? titleFromMessage(cleanMessage) : null,
  };
}

/**
 * The folder a handle stands for, described — or a refusal: an unknown
 * handle (not one this window offered), or a folder that is no longer a
 * directory on this machine.
 */
async function folderOf(deps: Pick<StartRunDeps, 'folders'>, handle: unknown) {
  if (typeof handle !== 'string') throw new Error('Choose a folder.');
  const resolved = deps.folders.registry.resolve(handle);
  const described = await describeFolder(deps.folders, resolved);
  if (!described) {
    throw new Error(
      `${resolved} is not a folder on this machine any more. Pick another.`,
    );
  }
  return described;
}

/**
 * The folder's local branches and the one to preselect — what the New
 * session dialog's branch field shows for a worktree run. Through the
 * engine, so the daemon (which will create the worktree) is the one
 * reading the repo.
 */
export async function listRunBranches(
  deps: Pick<StartRunDeps, 'daemon' | 'folders'>,
  folderHandle: unknown,
): Promise<RunBranches> {
  const daemon = deps.daemon();
  if (!daemon) throw new Error(ENGINE_NOT_RUNNING);
  const folder = await folderOf(deps, folderHandle);
  if (folder.kind !== 'repo') {
    throw new Error(`${folder.displayPath} is not a git repository.`);
  }
  const refs = await daemon.listRefs(folder.path);
  const branches = [...refs.branches].sort((a, b) => a.localeCompare(b));
  const local = new Set(branches);
  const origin =
    refs.remoteHeads.find((h) => h.remote === 'origin') ?? refs.remoteHeads[0];
  const suggested =
    (origin && local.has(origin.branch) && origin.branch) ||
    (local.has('main') && 'main') ||
    (local.has('master') && 'master') ||
    branches[0] ||
    null;
  return { branches, suggested };
}

/** True while nobody has moved the run off `provisioning` (a Stop would). */
async function stillProvisioning(
  ledger: LedgerClient,
  runId: string,
): Promise<boolean> {
  const fresh = await ledger.getRun(runId);
  return fresh?.status === 'provisioning';
}

async function failStart(
  deps: StartRunDeps,
  runId: string,
  stage: 'worktree' | 'session',
  error: unknown,
): Promise<void> {
  const message = describe(error);
  deps.logger.warn('engine: run start failed', { runId, stage, message });
  try {
    // provisionWorktree has already recorded a worktree failure on the
    // row and in the trail; a session failure is recorded here.
    await deps.ledger.updateRun(runId, {
      status: 'failed',
      reason: `Start failed at the ${stage}`,
      ...(stage === 'session'
        ? {
            errorKind: 'start',
            errorMessage: clip(message, MAX_ERROR_MESSAGE),
          }
        : {}),
    });
    if (stage === 'session') {
      await deps.ledger.appendEvent(runId, 'error', {
        stage,
        message: clip(message, MAX_EVENT_MESSAGE),
      });
    }
    deps.notify({ runId, status: 'failed' });
  } catch (ledgerError) {
    // A run stopped meanwhile is `cancelled`, which refuses `failed`; the
    // person's verdict stands and the failure is in the log above.
    deps.logger.warn('engine: could not record the start failure', {
      runId,
      message: describe(ledgerError),
    });
  }
}

/**
 * The part of a start that takes seconds to minutes. Exported for the
 * tests, which await it; `startRun` does not.
 */
export async function continueStart(
  deps: StartRunDeps & { daemonApi: DaemonRunsApi },
  run: AgentRun,
  /** The picked folder: the repository to take a worktree of, or the cwd itself. */
  folderPath: string,
  firstMessage: string | null = null,
): Promise<void> {
  const { ledger, daemonApi: daemon } = deps;
  let stage: 'worktree' | 'session' = 'worktree';
  try {
    let cwd = folderPath;
    let branch: string | null = null;
    if (run.isolation === 'worktree') {
      // W2: writes worktree_path / branch / base_ref and the
      // worktree_created event, or errorKind 'provision' + an error
      // event, then throws.
      const worktree = await provisionWorktree(
        {
          daemon,
          ledger,
          worktreesDir: deps.worktreesDir,
          logger: deps.logger,
        },
        {
          run,
          repoPath: folderPath,
          ticketIdentifier: null,
          baseRef: run.baseRef ?? undefined,
        },
      );
      cwd = worktree.worktreePath;
      branch = worktree.branch;
      if (!(await stillProvisioning(ledger, run.id))) {
        deps.logger.info(
          'engine: run left provisioning before its session started; not starting it',
          {
            runId: run.id,
          },
        );
        return;
      }
    }

    stage = 'session';
    const { sessionId } = await daemon.startSession({
      conversationId: run.id,
      providerId: run.providerId,
      cwd,
      sessionId: null,
      modeId: run.autoApprove ? AUTO_APPROVE_MODE_ID : null,
      ...(firstMessage ? { initialQueue: [{ text: firstMessage }] } : {}),
    });
    if (!(await stillProvisioning(ledger, run.id))) {
      deps.logger.info(
        'engine: run was stopped while its session started; killing it',
        {
          runId: run.id,
        },
      );
      await daemon.killSession(run.id).catch((error: unknown) =>
        deps.logger.warn('engine: kill after a cancelled start did not apply', {
          runId: run.id,
          message: describe(error),
        }),
      );
      return;
    }

    const running = await ledger.updateRun(run.id, {
      status: 'running',
      reason: 'The daemon started the session',
      daemonSessionId: run.id,
      providerSessionId: sessionId,
      cwd,
    });
    await ledger.appendEvent(run.id, 'session_started', {
      providerSessionId: sessionId,
      cwd,
      isolation: run.isolation,
      branch,
      baseRef: run.baseRef,
      autoApprove: run.autoApprove,
      firstMessage: firstMessage !== null,
    });
    if (firstMessage) {
      await ledger.appendEvent(run.id, 'prompt_sent', {
        by: 'user',
        kind: 'first-message',
      });
    }
    deps.notify({ runId: run.id, status: running.status });
    deps.logger.info('engine: run session started', {
      runId: run.id,
      providerSessionId: sessionId,
    });
  } catch (error) {
    // A Stop that landed while the worktree was being made: the ledger
    // says cancelled and refused the worktree write (409). The person's
    // verdict stands; the worktree stays on disk as W2's rule says.
    if (!(await stillProvisioning(ledger, run.id))) {
      deps.logger.info(
        'engine: run left provisioning during its worktree; not recording a failure',
        { runId: run.id, message: describe(error) },
      );
      return;
    }
    await failStart(deps, run.id, stage, error);
  }
}

/**
 * Creates the run and answers once it is `provisioning`; the worktree and
 * the session follow (`continueStart`). Every refusal — engine down, no
 * such project, no linked repo, a base branch the repo does not have —
 * happens before a row is written.
 */
export async function startRun(
  deps: StartRunDeps,
  rawInput: unknown,
): Promise<AgentRun> {
  const input = validateStartInput(rawInput);
  const daemon = deps.daemon();
  if (!daemon) throw new Error(ENGINE_NOT_RUNNING);
  const folder = await folderOf(deps, input.folder);
  if (input.isolation === 'worktree') {
    if (folder.kind !== 'repo') {
      throw new Error(
        `${folder.displayPath} is not a git repository, so there is no branch to take a worktree from. Work in the folder directly instead.`,
      );
    }
    const branches = await daemon.listLocalBranches(folder.path);
    if (!input.baseRef || !branches.includes(input.baseRef)) {
      throw new Error(
        `${input.baseRef ?? '(none)'} is not a local branch of ${folder.displayPath}.`,
      );
    }
  }

  const created = await deps.ledger.createRun({
    projectId: folder.projectId,
    ownerMemberId: input.ownerMemberId,
    entry: 'independent',
    providerId: input.providerId,
    isolation: input.isolation,
    autoApprove: input.autoApprove,
    ...(input.isolation === 'worktree' && input.baseRef
      ? { baseRef: input.baseRef }
      : {}),
    title: input.title,
  });
  const run = await deps.ledger.updateRun(created.id, {
    status: 'provisioning',
    reason: 'Started from the sessions panel',
    // A direct run's cwd is known now; a worktree run's once provisioned.
    ...(input.isolation === 'directory' ? { cwd: folder.path } : {}),
  });
  deps.notify({ runId: run.id, status: run.status });
  deps.logger.info('engine: run starting', {
    runId: run.id,
    providerId: run.providerId,
    isolation: run.isolation,
    folder: folder.path,
    autoApprove: run.autoApprove,
  });
  await rememberFolder(
    deps.folders.recentsFile,
    folder.path,
    input.autoApprove,
  ).catch((error: unknown) =>
    deps.logger.warn('engine: recent folders not written', {
      message: describe(error),
    }),
  );

  // Not awaited: the renderer has its row; what follows reports through
  // the ledger and `runs:changed`. Never rejects — every failure is a
  // ledger write inside.
  void continueStart(
    { ...deps, daemonApi: daemon },
    run,
    folder.path,
    input.firstMessage,
  );
  return run;
}

/** The most lines of `git log` / `git status` the note carries, each. */
export const NOTE_MAX_LINES = 40;

function firstLines(text: string, max: number): string {
  const lines = text
    .replace(/\n$/, '')
    .split('\n')
    .filter((l) => l.length);
  if (lines.length <= max) return lines.join('\n');
  return `${lines.slice(0, max).join('\n')}\n… (${lines.length - max} more)`;
}

/**
 * What a fresh session is told about the worktree it woke up in: the
 * branch, the commits on it since the base, the uncommitted changes.
 * Bounded, through the hardened runner, only after the worktree's `.git`
 * has been checked — the same three rules the diff follows.
 */
export async function buildResumeNote(
  deps: Pick<StartRunDeps, 'git' | 'assertWorktreeGitDir'>,
  run: Pick<AgentRun, 'worktreePath' | 'branch' | 'baseRef'>,
): Promise<string> {
  const cwd = run.worktreePath;
  if (!cwd) throw new Error('This run has no worktree.');
  await deps.assertWorktreeGitDir(cwd);
  const range =
    run.baseRef && run.baseRef.split('/').every(isRefSafeComponent)
      ? `${run.baseRef}..HEAD`
      : 'HEAD';
  const log = await deps.git(
    [
      'log',
      '--oneline',
      '--no-decorate',
      `-n${NOTE_MAX_LINES + 1}`,
      range,
      '--',
    ],
    { cwd },
  );
  const status = await deps.git(
    ['status', '--short', '--untracked-files=all', '--'],
    { cwd },
  );
  const commits = log.code === 0 ? firstLines(log.stdout, NOTE_MAX_LINES) : '';
  const changes =
    status.code === 0 ? firstLines(status.stdout, NOTE_MAX_LINES) : '';
  return [
    'Waypoint resumed this run after an interruption, but your previous conversation could not be restored, so this is a fresh session in the same worktree. Here is where things stand.',
    '',
    `Branch: ${run.branch ?? '(unknown)'}${run.baseRef ? ` (from ${run.baseRef})` : ''}`,
    `Commits on this branch${run.baseRef ? ` since ${run.baseRef}` : ''}:`,
    commits || '(none)',
    '',
    'Uncommitted changes:',
    changes || '(none)',
    '',
    'Wait for the next instruction; do not start work on your own.',
  ].join('\n');
}

async function sendResumeNote(
  deps: StartRunDeps,
  daemon: DaemonRunsApi,
  run: AgentRun,
): Promise<void> {
  const note = await buildResumeNote(deps, run);
  await daemon.sendPrompt(run.id, note);
  await deps.ledger.appendEvent(run.id, 'prompt_sent', {
    by: 'waypoint',
    kind: 'resume-note',
  });
}

/**
 * An `interrupted` run, back on its worktree. Answers the outcome; a
 * daemon refusal (auth, spawn) returns the run to `interrupted` with the
 * reason on the row and rethrows, so the panel shows the sentence and the
 * run stays resumable.
 */
export async function resumeRun(
  deps: StartRunDeps,
  runId: unknown,
): Promise<ResumeRunResult> {
  if (typeof runId !== 'string') throw new Error('Not a run id.');
  assertRunId(runId);
  const run = await deps.ledger.getRun(runId);
  if (!run) throw new Error(`No run ${runId} in the ledger.`);
  if (run.status !== 'interrupted') {
    return { outcome: 'not-resumable', status: run.status };
  }
  const cwd = run.cwd ?? run.worktreePath;
  if (!cwd) {
    return { outcome: 'worktree-gone', status: run.status };
  }
  // A worktree run's cwd must be under worktreesDir — the same rule every
  // other main-side use of the path applies: a row naming a place outside
  // it is a row someone edited, not a cwd to hand an agent. A direct
  // run's cwd is the folder the person picked; it only has to exist.
  if (run.isolation !== 'directory') {
    await assertUnder(cwd, deps.worktreesDir);
  }
  const present = await fs
    .stat(cwd)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!present) {
    return { outcome: 'worktree-gone', status: run.status };
  }
  const daemon = deps.daemon();
  if (!daemon) throw new Error(ENGINE_NOT_RUNNING);

  const provisioning = await deps.ledger.updateRun(run.id, {
    status: 'provisioning',
    reason: 'Resume from the sessions panel',
  });
  deps.notify({ runId: run.id, status: provisioning.status });

  let sessionId: string;
  try {
    ({ sessionId } = await daemon.startSession({
      conversationId: run.id,
      providerId: run.providerId,
      cwd,
      sessionId: run.providerSessionId,
      modeId: run.autoApprove ? AUTO_APPROVE_MODE_ID : null,
    }));
  } catch (error) {
    const message = describe(error);
    deps.logger.warn('engine: resume failed', { runId: run.id, message });
    await deps.ledger
      .updateRun(run.id, {
        status: 'interrupted',
        reason: 'Resume failed; still resumable',
        errorKind: 'resume',
        errorMessage: clip(message, MAX_ERROR_MESSAGE),
      })
      .catch(() => {});
    await deps.ledger
      .appendEvent(run.id, 'error', {
        stage: 'resume',
        message: clip(message, MAX_EVENT_MESSAGE),
      })
      .catch(() => {});
    deps.notify({ runId: run.id, status: 'interrupted' });
    throw error;
  }

  const loaded =
    run.providerSessionId !== null && sessionId === run.providerSessionId;
  const outcome = loaded ? 'loaded' : 'replaced-by-new';
  const running = await deps.ledger.updateRun(run.id, {
    status: 'running',
    reason: loaded
      ? 'Resumed: the provider restored the session'
      : 'Resumed: the provider could not restore the session; a fresh one was started in the same worktree',
    daemonSessionId: run.id,
    providerSessionId: sessionId,
    errorKind: null,
    errorMessage: null,
  });
  await deps.ledger.appendEvent(run.id, 'session_resumed', {
    outcome,
    providerSessionId: sessionId,
    previousProviderSessionId: run.providerSessionId,
  });
  deps.notify({ runId: run.id, status: running.status });
  deps.logger.info('engine: run resumed', { runId: run.id, outcome });

  if (!loaded) {
    // Fire and forget: the note is the fresh session's first turn, and a
    // turn is not something a resume waits on. Its failure is logged.
    void sendResumeNote(deps, daemon, run).catch((error: unknown) =>
      deps.logger.warn('engine: resume note was not delivered', {
        runId: run.id,
        message: describe(error),
      }),
    );
  }
  return { outcome, status: running.status };
}
