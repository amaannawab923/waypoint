import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  DaemonApiError,
  DaemonRunsApi,
  DaemonWorkspaceRecord,
} from './daemonApi';
import {
  assertRunId,
  LedgerRequestError,
  type AgentRun,
  type LedgerClient,
} from './ledgerClient';

/**
 * A worktree per run, through the daemon — ROAD-55.
 *
 * Every run gets its own worktree of the project's linked repository,
 * outside the checkout (`paths.worktreesDir/<run id>`), created by the
 * daemon's workspace registry: its staged inspect → resolve-base →
 * add-worktree → verify pipeline with rollback, and its path safety, are
 * exactly the parts nobody should write twice. Waypoint's job is the
 * naming, the bookkeeping, and the policy:
 *
 *   naming    `agent/<TICKET>` for a dispatched run, `session/<short id>`
 *             for an independent one. If that branch already exists in the
 *             repository — a previous run about the same ticket — the
 *             daemon would silently reuse it, starting the new run from
 *             the old branch's head instead of `baseRef`; so a taken name
 *             gets the run's short id appended, and a fresh branch is cut.
 *   ids       the daemon's record id for the worktree IS the run id, and
 *             the repository's is a hash of its canonical path — so boot-
 *             time reconcile (ROAD-57) matches records to runs by id, never
 *             by guessing from paths.
 *   ledger    worktree_path (the daemon's canonical path, not the one we
 *             asked for), branch, base_ref and daemon_workspace_id land on
 *             the run the moment the daemon answers, with a
 *             worktree_created event; a failure lands too, as error_kind
 *             'provision' and an error event — the ledger never claims a
 *             worktree that does not exist.
 *   cleanup   only ever explicit: after a PR merged or the user abandoned
 *             the run. Never on a crash — what is on disk after one is
 *             evidence, and ROAD-57 marks such a run `interrupted` so it
 *             can be resumed on that same worktree.
 *
 * Copilot's `resolveRepoRoot` (agent/claudeSession.ts) is never used here:
 * it resolves the checkout the Copilot chat is grounded in, and a coding
 * run must never write into a checkout the user is working in.
 */

export interface ProvisionWorktreeInput {
  run: AgentRun;
  /** The project's linked repository (projects.repo_path). */
  repoPath: string;
  /** e.g. 'ROAD-55' — required for a dispatched run's branch name. */
  ticketIdentifier: string | null;
  /** Defaults to the run's own base_ref, else 'main'. */
  baseRef?: string;
}

export interface ProvisionedWorktree {
  worktreePath: string;
  branch: string;
  baseRef: string;
  daemonWorkspaceId: string;
  repositoryId: string;
}

export interface WorktreeDeps {
  daemon: DaemonRunsApi;
  ledger: LedgerClient;
  /** EnginePaths.worktreesDir. */
  worktreesDir: string;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

const DEFAULT_BASE_REF = 'main';

/** `run-abc1234` → `abc1234`: the part after the prefix, as ids.ts mints it. */
export function shortRunId(runId: string): string {
  const dash = runId.indexOf('-');
  return dash === -1 ? runId : runId.slice(dash + 1);
}

/**
 * Whether `component` may be one path component of a branch name, by
 * git's own check-ref-format rules: no control characters, space, or
 * `~ ^ : ? * [ \\`; no `..`, `@{`, `//`; no leading `-` or `.`; no
 * trailing `.` or `.lock`. Found in review, round 2: the first draft
 * said ticket identifiers were always `PROJECT-123`, but a project's
 * identifier is any non-empty string, and `agent/<that>` was handed to
 * git as-is — a permanently unprovisionable project, not an injection
 * (the daemon passes argv arrays), but a failure a person could not
 * read.
 */
export function isRefSafeComponent(component: string): boolean {
  if (component.length === 0 || component.length > 200) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f ~^:?*[\\]/.test(component)) return false;
  if (
    component.includes('..') ||
    component.includes('@{') ||
    component.includes('//')
  )
    return false;
  if (
    component.startsWith('-') ||
    component.startsWith('.') ||
    component.startsWith('/')
  )
    return false;
  if (
    component.endsWith('.') ||
    component.endsWith('/') ||
    component.endsWith('.lock')
  )
    return false;
  return true;
}

/**
 * The branch a run wants, before checking the repository: `agent/<TICKET>`
 * for a dispatched run whose ticket identifier is a safe ref component,
 * else `session/<short id>` — short ids are lowercase alphanumerics, so
 * that one is always valid.
 */
export function preferredBranchName(
  run: Pick<AgentRun, 'id' | 'entry'>,
  ticketIdentifier: string | null,
): string {
  if (
    run.entry === 'dispatched' &&
    ticketIdentifier &&
    isRefSafeComponent(ticketIdentifier)
  ) {
    return `agent/${ticketIdentifier}`;
  }
  return `session/${shortRunId(run.id)}`;
}

/** `preferredBranchName`, made unique against the branches that exist. */
export function chooseBranchName(
  run: Pick<AgentRun, 'id' | 'entry'>,
  ticketIdentifier: string | null,
  existingBranches: Iterable<string>,
): string {
  const taken = new Set(existingBranches);
  const preferred = preferredBranchName(run, ticketIdentifier);
  if (!taken.has(preferred)) return preferred;
  const suffixed = `${preferred}-${shortRunId(run.id)}`;
  if (!taken.has(suffixed)) return suffixed;
  // The same run id twice is impossible (ids are unique per row), so
  // this only protects against a branch someone made by hand.
  let n = 2;
  while (taken.has(`${suffixed}-${n}`)) n += 1;
  return `${suffixed}-${n}`;
}

export function worktreePathFor(worktreesDir: string, runId: string): string {
  return path.join(worktreesDir, runId);
}

/**
 * The id Waypoint asks the daemon to register a repository under: a hash
 * of its path, so two runs on one repo ask for the same record. This is
 * what Waypoint *requests*, not something the daemon derives — a
 * repository the daemon adopted on its own (as the parent of a worktree
 * it discovered) has a random id, and registerRepository hands back
 * whatever record exists for the path. Always go through
 * registerRepository; never look a repo up by this id alone. (Review
 * round 2 reworded this from a claim about the daemon.)
 */
export function repositoryRecordId(repoPath: string): string {
  return `repo-${createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 16)}`;
}

// What the ledger accepts (validation/agentRuns.schema.ts); a longer
// message is cut, never dropped — the ledger hearing "…" beats it hearing
// nothing because a 400 was swallowed (found in review, round 2).
const MAX_ERROR_MESSAGE = 4000;
const MAX_EVENT_MESSAGE = 12_000;
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describeDaemonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the run's worktree and records it. Throws on failure AFTER the
 * failure has been written to the ledger, so a caller can transition the
 * run to `failed` (or let the failure stand on an `interrupted` one) with
 * the error already on record.
 */
export async function provisionWorktree(
  deps: WorktreeDeps,
  input: ProvisionWorktreeInput,
): Promise<ProvisionedWorktree> {
  const { run } = input;
  // The run id names a directory under worktreesDir and a daemon record;
  // it came from an HTTP response, and the ledger client checks ids only
  // on the way *to* a URL (review round 2).
  assertRunId(run.id);
  const baseRef = input.baseRef ?? run.baseRef ?? DEFAULT_BASE_REF;
  if (!baseRef.split('/').every(isRefSafeComponent)) {
    throw new Error(`Not a usable base ref: ${JSON.stringify(baseRef)}`);
  }
  const repositoryId = repositoryRecordId(input.repoPath);
  const requestedPath = worktreePathFor(deps.worktreesDir, run.id);

  try {
    const repository = await deps.daemon.registerRepository(
      repositoryId,
      input.repoPath,
    );
    // Found in review, round 2: the pinned daemon ignores the request's
    // `preservePatterns` and copies whatever the repository's own
    // `.emdash.json` names — typically `.env` — into every new worktree,
    // exactly where the agent will run. The daemon is Waypoint-private,
    // so its personal config layer (personal > team) is Waypoint's
    // policy: nothing gitignored is ever copied into an agent worktree.
    await deps.daemon.disableArtifactCopy(repository.id);
    const branch = chooseBranchName(
      run,
      input.ticketIdentifier,
      await deps.daemon.listLocalBranches(repository.path),
    );
    deps.logger.info('engine: creating run worktree', {
      runId: run.id,
      branch,
      baseRef,
      path: requestedPath,
    });

    const record = await createWorktreeWithFallback(
      deps.daemon,
      {
        workspaceId: run.id,
        repositoryId: repository.id,
        branch,
        baseRef,
        path: requestedPath,
      },
      run,
    );

    // The daemon's canonical path must be where we asked, or under it —
    // a record that says otherwise is not a worktree we will run an agent
    // in (review round 2).
    await assertUnder(record.path, deps.worktreesDir);
    if (record.lifecycle?.steps.some((step) => step.id === 'copy-artifacts')) {
      await deps.daemon
        .deleteWorktree(record.id, { deleteBranch: true })
        .catch(() => {});
      throw new Error(
        'The daemon scheduled an artifact copy into the run worktree despite the personal override; refusing to use it.',
      );
    }

    const provisioned: ProvisionedWorktree = {
      worktreePath: record.path,
      branch: record.creation?.branch ?? branch,
      baseRef,
      daemonWorkspaceId: record.id,
      repositoryId: repository.id,
    };
    await deps.ledger.updateRun(run.id, {
      worktreePath: provisioned.worktreePath,
      branch: provisioned.branch,
      baseRef,
      daemonWorkspaceId: provisioned.daemonWorkspaceId,
    });
    await deps.ledger.appendEvent(run.id, 'worktree_created', {
      path: provisioned.worktreePath,
      branch: provisioned.branch,
      baseRef,
      repositoryId: repository.id,
    });
    return provisioned;
  } catch (error) {
    // The ledger refusing the write (409: the run was stopped while the
    // worktree was being made, W4) is not a provisioning failure to
    // record — the record is read-only, and an "error" event about the
    // ledger's own refusal is noise in the trail. The caller sees the
    // refusal and decides (found in W4's live pass, SESS-23).
    if (error instanceof LedgerRequestError && error.status === 409) {
      deps.logger.info(
        'engine: run worktree made after the run was stopped; left on disk',
        {
          runId: run.id,
        },
      );
      throw error;
    }
    const message = describeDaemonError(error);
    deps.logger.warn('engine: run worktree failed', { runId: run.id, message });
    // The ledger hears about it before the caller does. Not a status move —
    // the caller owns the run's status and decides between `failed` and
    // leaving an `interrupted` run alone.
    await deps.ledger
      .updateRun(run.id, {
        errorKind: 'provision',
        errorMessage: clip(message, MAX_ERROR_MESSAGE),
      })
      .catch(() => {});
    await deps.ledger
      .appendEvent(run.id, 'error', {
        stage: 'worktree',
        message: clip(message, MAX_EVENT_MESSAGE),
      })
      .catch(() => {});
    throw error;
  }
}

/**
 * The one retry the naming rule cannot pre-empt: `listLocalBranches` says
 * the branch is free, but between that read and `add-worktree` someone
 * checked it out, or it exists only as a worktree the registry does not
 * know. The daemon answers stage-failed/add-worktree; we cut a suffixed
 * branch instead. Any other failure is final.
 *
 * Observed live: the daemon registers the record before it runs the
 * pipeline and keeps it, marked failed, afterwards — and a replay under
 * the same id with a DIFFERENT spec is `immutable-field-mismatch`, not a
 * retry. So the failed record is deleted (idempotent; there is no
 * artifact to remove) before the suffixed attempt is made under the same
 * run id.
 */
async function createWorktreeWithFallback(
  daemon: DaemonRunsApi,
  request: Parameters<DaemonRunsApi['createWorktree']>[0],
  run: Pick<AgentRun, 'id'>,
): Promise<DaemonWorkspaceRecord> {
  try {
    return await daemon.createWorktree(request);
  } catch (error) {
    const detail = (error as DaemonApiError).detail as
      { type?: string; stage?: string } | undefined;
    const alreadySuffixed = request.branch.endsWith(`-${shortRunId(run.id)}`);
    if (
      detail?.type === 'stage-failed' &&
      detail.stage === 'add-worktree' &&
      !alreadySuffixed
    ) {
      await daemon.deleteWorktree(request.workspaceId, { deleteBranch: false });
      return daemon.createWorktree({
        ...request,
        branch: `${request.branch}-${shortRunId(run.id)}`,
      });
    }
    throw error;
  }
}

export type ReleaseReason = 'merged' | 'abandoned';

/**
 * Removes the run's worktree. `merged` also deletes the local branch —
 * the PR has it; `abandoned` keeps the branch so the work stays
 * recoverable from git even though the checkout is gone. Idempotent: a
 * worktree already gone is success, and the ledger records the removal
 * either way.
 */
export async function releaseWorktree(
  deps: WorktreeDeps,
  run: AgentRun,
  reason: ReleaseReason,
): Promise<void> {
  assertRunId(run.id);
  // Waypoint always registers the worktree under the run's own id
  // (provisionWorktree). A ledger row naming another record is a row
  // someone edited, and `merged` deletes a branch — refuse rather than
  // remove a worktree that is not this run's (review round 2).
  if (run.daemonWorkspaceId !== null && run.daemonWorkspaceId !== run.id) {
    throw new Error(
      `Run ${run.id} names daemon record ${run.daemonWorkspaceId}; a run's worktree record is always its own id. Refusing to remove it.`,
    );
  }
  await deps.daemon.deleteWorktree(run.id, {
    deleteBranch: reason === 'merged',
  });
  deps.logger.info('engine: run worktree removed', { runId: run.id, reason });
  await deps.ledger.appendEvent(run.id, 'worktree_removed', {
    path: run.worktreePath,
    branch: run.branch,
    reason,
    branchDeleted: reason === 'merged',
  });
}

/**
 * `candidate` (canonical) must be `root` itself or inside it. Exported for
 * runsIpc.ts, which applies the same rule before running `git` in, or
 * revealing, a run's worktree: a ledger row naming a path outside
 * worktreesDir is a row someone edited, not a place to run commands.
 */
export async function assertUnder(
  candidate: string,
  root: string,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const realCandidate = await fs
    .realpath(candidate)
    .catch(() => path.resolve(candidate));
  const rel = path.relative(realRoot, realCandidate);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new Error(
    `The daemon placed the worktree at ${candidate}, outside ${root}. Refusing to use it.`,
  );
}
