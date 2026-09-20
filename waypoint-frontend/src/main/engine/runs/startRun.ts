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
import { agentEnvFor } from './agentEnv';
import type { DaemonRunsApi } from './daemonApi';
import { describeFolder, rememberFolder, type FolderDeps } from './folders';
import { claimForInitialQueue, markDelivered, revertClaimed } from './outbox';
import {
  assertRunId,
  type AgentRun,
  type AgentRunStatus,
  type LedgerClient,
} from './ledgerClient';
import {
  assertUnder,
  DEFAULT_BASE_REF,
  isRefSafeComponent,
  provisionWorktree,
  reprovisionWorktree,
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

/**
 * Whether `cwd` is still a genuine, present linked worktree under
 * `worktreesDir` — the three checks `resumeRunCore` used to apply
 * unconditionally before refusing a resume outright; now the gate for
 * whether it needs `reprovisionWorktree` (ROAD-XXX) instead.
 *
 * `assertUnder` is deliberately NOT one of the checks folded into this
 * boolean and left to throw straight out of `resumeRunCore`: a worktree
 * gone, or never made, is ordinary and worth healing transparently, but a
 * ledger row naming a place outside `worktreesDir` at all is a row
 * someone edited (or a bug), not a cwd Waypoint provisioned — reprovision
 * always targets the run's own correct, in-bounds path regardless, so
 * silently "healing" this case would quietly paper over exactly the
 * tampering `assertUnder` exists to catch instead of surfacing it.
 */
async function isUsableWorktree(
  deps: Pick<StartRunDeps, 'assertWorktreeGitDir'>,
  cwd: string,
): Promise<boolean> {
  const linked = await deps.assertWorktreeGitDir(cwd).then(
    () => true,
    () => false,
  );
  if (!linked) return false;
  return fs
    .stat(cwd)
    .then((s) => s.isDirectory())
    .catch(() => false);
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
export interface ContinueStartOptions {
  /** `ROAD-116` for a dispatched run — names the worktree's branch `agent/ROAD-116` (W2's rule). */
  ticketIdentifier?: string | null;
  /** Environment overrides for the agent process (W5a §2.5's scrub); none for an independent run. */
  env?: Record<string, string>;
}

/**
 * The provider mode a run's session starts in: what the row says, else
 * what its auto-approve flag implies. The row is written by startRun and
 * dispatch, so resume and start agree.
 */
export function sessionModeOf(
  run: Pick<AgentRun, 'modeId' | 'autoApprove'>,
): string | null {
  if (run.modeId) return run.modeId;
  return run.autoApprove ? AUTO_APPROVE_MODE_ID : null;
}

export async function continueStart(
  deps: StartRunDeps & { daemonApi: DaemonRunsApi },
  run: AgentRun,
  /** The picked folder: the repository to take a worktree of, or the cwd itself. */
  folderPath: string,
  firstMessage: string | null = null,
  options: ContinueStartOptions = {},
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
          ticketIdentifier: options.ticketIdentifier ?? null,
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
    const modeId = sessionModeOf(run);
    // Never-lock (design §2.4 trigger 1): messages typed while this start
    // was on its way ride in as the session's initial queue, after the
    // first message — claimed `sending` first, so a host that dies before
    // the daemon answers leaves the same evidence a plain drain would.
    const pending = await claimForInitialQueue(
      { ledger, logger: deps.logger },
      run,
    ).catch((error: unknown) => {
      deps.logger.warn('engine: outbox could not be read for the start', {
        runId: run.id,
        message: describe(error),
      });
      return [] as Awaited<ReturnType<typeof claimForInitialQueue>>;
    });
    const initialQueue = [
      ...(firstMessage ? [{ text: firstMessage }] : []),
      ...pending.map((p) => ({ text: p.text })),
    ];
    const { sessionId } = await daemon.startSession({
      conversationId: run.id,
      providerId: run.providerId,
      cwd,
      sessionId: null,
      modeId,
      ...(initialQueue.length ? { initialQueue } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    // The stillProvisioning check runs BEFORE marking these delivered
    // (found in review): a Stop landing in the window while startSession
    // was in flight kills the session right below, and this same start
    // is the only witness to whether the agent ever actually saw its
    // initialQueue — recording `delivered` first and then destroying
    // that session left rows permanently marked delivered with no way
    // to know if they were.
    if (!(await stillProvisioning(ledger, run.id))) {
      deps.logger.info(
        'engine: run was stopped while its session started; killing it',
        {
          runId: run.id,
        },
      );
      if (pending.length) {
        await revertClaimed(
          { ledger, logger: deps.logger },
          run.id,
          pending.map((p) => p.row),
        );
      }
      await daemon.killSession(run.id).catch((error: unknown) =>
        deps.logger.warn('engine: kill after a cancelled start did not apply', {
          runId: run.id,
          message: describe(error),
        }),
      );
      return;
    }
    if (pending.length) {
      await markDelivered(
        { ledger, logger: deps.logger },
        run.id,
        pending.map((p) => p.row),
      );
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
      modeId,
      ...(run.intent ? { intent: run.intent } : {}),
      // The keys scrubbed from the agent's env, never their values.
      ...(options.env ? { envScrubbed: Object.keys(options.env).sort() } : {}),
      firstMessage: firstMessage !== null,
    });
    if (firstMessage) {
      await ledger.appendEvent(run.id, 'prompt_sent', {
        by: run.entry === 'dispatched' ? 'waypoint' : 'user',
        kind: run.entry === 'dispatched' ? 'brief' : 'first-message',
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
    modeId: input.autoApprove ? AUTO_APPROVE_MODE_ID : null,
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

/** Whether the run's worktree had to be recreated for this resume (ROAD-XXX), and how much of its prior state survived. */
export interface ResumeWorktreeState {
  recreated: boolean;
  /** recreated only: the run's own branch still existed and was reused, vs. a fresh branch of the same name from baseRef. Meaningless when `recreated` is false. */
  branchReused: boolean;
}

const WORKTREE_INTACT: ResumeWorktreeState = {
  recreated: false,
  branchReused: true,
};

/**
 * The four sentences a resume note can open with — exported so finalize
 * can recognise a legacy Waypoint-authored note *turn* (design §4.6:
 * before never-lock the note was sent as a prompt of its own, and the
 * agent's "understood" reply must not be filed as a report).
 */
export const RESUME_NOTE_OPENINGS: readonly string[] = [
  'Waypoint resumed this run, but its worktree had been removed since it last ran',
  'Waypoint resumed this run, but its worktree — and the branch itself — were both gone',
  'Waypoint resumed this run; it never had a session running before',
  'Waypoint resumed this run after an interruption, but your previous conversation could not be restored',
];

/** Whether a prompt is (was) one of Waypoint's own resume notes rather than a person's words. */
export function isResumeNoteText(text: string): boolean {
  const head = text.trimStart();
  return RESUME_NOTE_OPENINGS.some((opening) => head.startsWith(opening));
}

/** The note's first sentence: the one thing about this resume the agent most needs to hear. */
function resumeOpening(
  providerSessionId: string | null,
  worktree: ResumeWorktreeState,
): string {
  // A recreated worktree (this run's own checkout was gone, or never
  // successfully made) takes priority over the conversation framings
  // below — it is the more consequential discontinuity (files on disk,
  // not just the provider's own memory of the conversation), and worth
  // naming plainly rather than folding into the ordinary "fresh session"
  // note.
  if (worktree.recreated) {
    return worktree.branchReused
      ? 'Waypoint resumed this run, but its worktree had been removed since it last ran (or was never successfully made); it was recreated by checking out the same branch again, so your committed work is intact. Only UNCOMMITTED changes from before are gone. Here is where things stand now.'
      : 'Waypoint resumed this run, but its worktree — and the branch itself — were both gone; Waypoint could not recover your prior state, so this is a fresh branch from the base, in a new worktree. Here is where things stand now.';
  }
  // ROAD-XXX: a run that died before any session ever started (queued or
  // provisioning straight to failed, say) has never had a "previous
  // conversation" to fail to restore — this is its first session, not a
  // fresh one replacing a lost one.
  if (providerSessionId === null) {
    return 'Waypoint resumed this run; it never had a session running before, so this is its first one, in the worktree as it stands. Here is where things stand.';
  }
  return 'Waypoint resumed this run after an interruption, but your previous conversation could not be restored, so this is a fresh session in the same worktree. Here is where things stand.';
}

/**
 * What a fresh session is told about the worktree it woke up in: the
 * branch, the commits on it since the base, the uncommitted changes.
 * Bounded, through the hardened runner, only after the worktree's `.git`
 * has been checked — the same three rules the diff follows.
 */
export async function buildResumeNote(
  deps: Pick<StartRunDeps, 'git' | 'assertWorktreeGitDir'>,
  run: Pick<
    AgentRun,
    'worktreePath' | 'branch' | 'baseRef' | 'providerSessionId'
  >,
  worktree: ResumeWorktreeState = WORKTREE_INTACT,
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
  const opening = resumeOpening(run.providerSessionId, worktree);
  return [
    opening,
    '',
    `Branch: ${run.branch ?? '(unknown)'}${run.baseRef ? ` (from ${run.baseRef})` : ''}`,
    `Commits on this branch${run.baseRef ? ` since ${run.baseRef}` : ''}:`,
    commits || '(none)',
    '',
    'Uncommitted changes:',
    changes || '(none)',
  ].join('\n');
}

/**
 * The statuses a run can be continued from — every status that is not
 * live (never-lock, 2026-09-20) — mirrors the backend's
 * `REVIVABLE_RUN_STATUSES` (runStatusMachine.ts) exactly; duplicated
 * across the repo boundary the same way reconcile.ts's
 * `LIVE_RUN_STATUSES` already is, with the same drift test
 * (startRun.test.ts reads the backend's source).
 */
export const RESUMABLE_RUN_STATUSES: readonly AgentRunStatus[] = [
  'needs-review',
  'done',
  'interrupted',
  'failed',
  'cancelled',
];

/** Who asked — the explicit Resume action, a send, or the pane opening (warm-up materialised by the first send). */
export type ResumeTrigger = 'button' | 'message' | 'open-then-message';

/**
 * Never-lock: what `resumeRunCore` hands its caller beyond the wire-facing
 * result — the `hiddenContext` the first prompt after this resume should
 * carry (the resume note and/or the continuation note), never sent as a
 * turn of its own.
 */
export interface ResumeRunCoreResult extends ResumeRunResult {
  /** Present after a successful resume; empty when nothing needs saying. */
  hiddenContext?: string;
}

/**
 * The continuation note (design §4.7): a dispatched run whose report was
 * already filed is told how Waypoint decides whether a later turn is
 * work (file a report → published) or conversation (just answer).
 */
export function continuationNote(
  run: Pick<AgentRun, 'finalizeCount' | 'verdict' | 'ticketId'>,
  ticketLabel: string | null,
): string | null {
  if (run.finalizeCount === 0) return null;
  const where = ticketLabel ?? 'its ticket';
  return [
    `This run's last report was already filed on ${where}${run.verdict ? ` (verdict: ${run.verdict})` : ''}.`,
    'If you make changes in this conversation, end that turn with the same `Verdict:` / `## Summary` report you gave before, so Waypoint publishes them and files a follow-up.',
    'When you are only answering a question, reply normally, without a Verdict line — nothing is filed for a plain answer.',
  ].join(' ');
}

/** The last committed turn's id in the ledger's snapshot — where a marker for this resume anchors (design §5.2). */
async function lastSnapshotTurnId(
  ledger: LedgerClient,
  runId: string,
): Promise<string | null> {
  try {
    const snapshot = await ledger.getTranscript(runId);
    const turns = (snapshot?.turns ?? []) as Array<{ id?: unknown }>;
    const last = turns[turns.length - 1];
    return typeof last?.id === 'string' ? last.id : null;
  } catch {
    return null;
  }
}

/**
 * A run that is not live, back on its worktree — needs-review, done,
 * interrupted, failed or cancelled (never-lock, 2026-09-20). Answers the
 * outcome; never refuses:
 *
 *  - a live run is `already-live` (the caller sends to the session);
 *  - a worktree that cannot be reached and cannot be recreated is
 *    `cannot-reach-worktree` with the outbox reason (the caller accepts
 *    the message into the run's outbox; nothing is reopened);
 *  - a daemon refusal (auth, spawn) returns the run to the status it was
 *    actually in before this call — not unconditionally `interrupted` —
 *    and answers `spawn-failed` (the caller outboxes; the explicit Resume
 *    action shows the daemon's sentence);
 *  - a Stop landing between reopenRun and startSession is
 *    `cancelled-mid-resume` (the person overrode the resume).
 *
 * The resume note (a fresh provider session, or a recreated worktree) is
 * no longer a turn of its own: it comes back as `hiddenContext` for the
 * caller's first prompt (design §4.7), so a resume never spends an agent
 * turn and never leaves a Waypoint-authored message in the transcript.
 */
export async function resumeRunCore(
  deps: StartRunDeps,
  runId: unknown,
  trigger: ResumeTrigger,
  /** For a session already loaded by a warm-up (warm.ts): its provider id and whether it was the same one. */
  warmed: { sessionId: string; loaded: boolean } | null = null,
): Promise<ResumeRunCoreResult> {
  if (typeof runId !== 'string') throw new Error('Not a run id.');
  assertRunId(runId);
  const run = await deps.ledger.getRun(runId);
  if (!run) throw new Error(`No run ${runId} in the ledger.`);
  if (!RESUMABLE_RUN_STATUSES.includes(run.status)) {
    return { outcome: 'already-live', status: run.status };
  }
  const originalStatus = run.status;
  const daemon = deps.daemon();
  if (!daemon) throw new Error(ENGINE_NOT_RUNNING);

  let cwd = run.cwd ?? run.worktreePath;
  let { branch } = run;
  let worktreeRecreated = false;
  let branchReused = true;
  if (run.isolation === 'directory') {
    // A hand-picked folder, not a Waypoint-managed worktree — there is no
    // branch or repo to recreate it from. Not a refusal: the message
    // waits in the outbox until the folder is back (design §2.4).
    const present =
      cwd !== null &&
      (await fs
        .stat(cwd)
        .then((s) => s.isDirectory())
        .catch(() => false));
    if (!present) {
      return {
        outcome: 'cannot-reach-worktree',
        status: run.status,
        reason: 'folder-missing',
        message: `this run's folder is not on disk at ${cwd ?? '(unknown)'}`,
      };
    }
  } else {
    // A row naming a place outside worktreesDir at all is a row someone
    // edited (or a bug) — this throws straight out, not folded into the
    // reprovision path below (isUsableWorktree's own doc comment).
    if (cwd !== null) await assertUnder(cwd, deps.worktreesDir);
    const usable = cwd !== null && (await isUsableWorktree(deps, cwd));
    if (!usable) {
      // Gone from disk (`git worktree remove`, a cleanup) or never
      // successfully made at all (the run died during its own
      // provisioning): recreate it, on the run's own branch when that
      // still exists (history intact), else a fresh branch of the same
      // name from baseRef — mirrors emdash's own `replayWorktreeCreation`.
      const project = run.projectId
        ? await deps.ledger.getProject(run.projectId)
        : null;
      if (!project?.repoPath) {
        return {
          outcome: 'cannot-reach-worktree',
          status: run.status,
          reason: 'repository-missing',
          message: "the project's repository is not linked",
        };
      }
      try {
        const reprovisioned = await reprovisionWorktree(
          {
            daemon,
            ledger: deps.ledger,
            worktreesDir: deps.worktreesDir,
            logger: deps.logger,
          },
          run,
          project.repoPath,
        );
        cwd = reprovisioned.worktreePath;
        branch = reprovisioned.branch;
        branchReused = reprovisioned.branchReused;
        worktreeRecreated = true;
      } catch (error) {
        deps.logger.warn(
          'engine: could not recreate the run worktree for resume',
          { runId: run.id, message: describe(error) },
        );
        return {
          outcome: 'cannot-reach-worktree',
          status: run.status,
          reason: 'repository-missing',
          message: describe(error),
        };
      }
    }
  }
  if (!cwd) {
    // Unreachable in practice — every path above either returns or
    // leaves cwd a real string — closing the type gap for startSession.
    return {
      outcome: 'cannot-reach-worktree',
      status: run.status,
      reason: 'folder-missing',
      message: 'this run has no folder recorded',
    };
  }

  // Where a marker for this resume anchors: after the last turn the
  // ledger's snapshot holds right now (design §5.2). Read before the
  // reopen so a Stop mid-resume costs nothing more than the read. A run
  // with no snapshot (one that never reached a turn end under Waypoint)
  // gets its anchor from the daemon's restored history below, once the
  // session is loaded — found live: anchored to nothing, the marker fell
  // after the turn the message itself started.
  let afterTurnId = await lastSnapshotTurnId(deps.ledger, run.id);

  const { run: provisioning } = await deps.ledger.reopenRun(
    run.id,
    trigger === 'button'
      ? 'Resume from the sessions panel'
      : 'Continued by a new message',
  );
  deps.notify({ runId: run.id, status: provisioning.status });

  // A Stop landing mid-resume (the same guard continueStart already
  // applies at its own two call sites) — reopenRun just put this run
  // live again, and nothing else re-reads it before the daemon call
  // below.
  if (!(await stillProvisioning(deps.ledger, run.id))) {
    const current = await deps.ledger.getRun(run.id);
    deps.logger.info(
      'engine: run left provisioning during resume; not starting its session',
      { runId: run.id, status: current?.status },
    );
    return {
      outcome: 'cancelled-mid-resume',
      status: current?.status ?? 'cancelled',
    };
  }

  if (worktreeRecreated) {
    // The fields reprovisionWorktree deliberately leaves for the caller
    // (its own doc comment): only now, past reopenRun, is the row no
    // longer terminal and so writable at all. Same values as a fresh
    // provisionWorktree would write, and identical to what a
    // previously-recorded worktree already carries, so the write-once
    // guard is satisfied in every case.
    await deps.ledger.updateRun(run.id, {
      worktreePath: cwd,
      branch,
      baseRef: run.baseRef ?? DEFAULT_BASE_REF,
      daemonWorkspaceId: run.id,
      // A branch that had to be cut afresh was deleted — on merge, the
      // usual reason — so the PR it had is over; the next report opens
      // a new one against the new branch (design §4.5).
      ...(!branchReused && run.prUrl ? { prUrl: null } : {}),
    });
    if (!branchReused && run.prUrl) {
      await deps.ledger
        .appendEvent(run.id, 'note', {
          stage: 'resume',
          publish: 'pr-superseded',
          previousUrl: run.prUrl,
          reason: 'branch recreated',
        })
        .catch(() => {});
    }
  }

  let sessionId: string;
  if (warmed) {
    ({ sessionId } = warmed);
  } else {
    try {
      ({ sessionId } = await daemon.startSession({
        conversationId: run.id,
        providerId: run.providerId,
        cwd,
        sessionId: run.providerSessionId,
        modeId: sessionModeOf(run),
        // A dispatched writing session comes back with the same scrubbed
        // env it started with (agentEnv.ts); an independent one with none.
        ...(agentEnvFor(run) ? { env: agentEnvFor(run) } : {}),
      }));
    } catch (error) {
      const message = describe(error);
      deps.logger.warn('engine: resume failed', { runId: run.id, message });
      await deps.ledger
        .updateRun(run.id, {
          status: originalStatus,
          reason: 'Resume failed; the run is back where it was',
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
      deps.notify({ runId: run.id, status: originalStatus });
      return {
        outcome: 'spawn-failed',
        status: originalStatus,
        reason: 'spawn-failed',
        message,
      };
    }
  }

  const loaded = warmed
    ? warmed.loaded
    : run.providerSessionId !== null && sessionId === run.providerSessionId;
  const outcome = loaded ? 'loaded' : 'replaced-by-new';
  if (afterTurnId === null && loaded) {
    afterTurnId = await Promise.resolve()
      .then(() => daemon.getHistory(run.id, 100))
      .then((turns) => {
        const last = turns[turns.length - 1];
        return typeof last?.id === 'string' ? last.id : null;
      })
      .catch((): string | null => null);
  }
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
    trigger,
    from: originalStatus,
    providerSessionId: sessionId,
    previousProviderSessionId: run.providerSessionId,
    afterTurnId,
    ...(worktreeRecreated ? { worktreeRecreated, branchReused } : {}),
  });
  deps.notify({ runId: run.id, status: running.status });
  deps.logger.info('engine: run resumed', {
    runId: run.id,
    outcome,
    trigger,
    worktreeRecreated,
  });

  // What the first prompt after this resume carries as hidden context:
  // the branch-state note when the provider's own memory could not be
  // restored or the files under it changed (a recreated worktree), and
  // the continuation note for a dispatched run whose report is filed.
  const notes: string[] = [];
  if (!loaded || worktreeRecreated) {
    try {
      notes.push(
        await buildResumeNote(
          deps,
          { ...run, worktreePath: cwd, branch },
          { recreated: worktreeRecreated, branchReused },
        ),
      );
    } catch (error) {
      deps.logger.warn('engine: resume note could not be built', {
        runId: run.id,
        message: describe(error),
      });
    }
  }
  const continuation = continuationNote(run, null);
  if (continuation) notes.push(continuation);
  return {
    outcome,
    status: running.status,
    ...(worktreeRecreated ? { worktreeRecreated, branchReused } : {}),
    ...(notes.length ? { hiddenContext: notes.join('\n\n') } : {}),
  };
}

/** The explicit "Resume" action (runs:resume). */
export async function resumeRun(
  deps: StartRunDeps,
  runId: unknown,
): Promise<ResumeRunResult> {
  const { hiddenContext: _note, ...result } = await resumeRunCore(
    deps,
    runId,
    'button',
  );
  return result;
}
