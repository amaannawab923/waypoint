import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  DaemonApiError,
  DaemonRunsApi,
  DaemonWorkspaceRecord,
} from './daemonApi';
import type { AgentRun, LedgerClient } from './ledgerClient';

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
 * The branch a run wants, before checking the repository. Ticket
 * identifiers are `PROJECT-123` (validation/tickets.schema.ts's shape)
 * and short ids are lowercase alphanumerics, so the result is always a
 * valid ref name — no sanitising, and nothing user-typed reaches git.
 */
export function preferredBranchName(
  run: Pick<AgentRun, 'id' | 'entry'>,
  ticketIdentifier: string | null,
): string {
  if (run.entry === 'dispatched' && ticketIdentifier)
    return `agent/${ticketIdentifier}`;
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

/** Stable per repository path, so two runs on one repo share one record. */
export function repositoryRecordId(repoPath: string): string {
  return `repo-${createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 16)}`;
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
  const baseRef = input.baseRef ?? run.baseRef ?? DEFAULT_BASE_REF;
  const repositoryId = repositoryRecordId(input.repoPath);
  const requestedPath = worktreePathFor(deps.worktreesDir, run.id);

  try {
    const repository = await deps.daemon.registerRepository(
      repositoryId,
      input.repoPath,
    );
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
    const message = describeDaemonError(error);
    deps.logger.warn('engine: run worktree failed', { runId: run.id, message });
    // The ledger hears about it before the caller does. Not a status move —
    // the caller owns the run's status and decides between `failed` and
    // leaving an `interrupted` run alone.
    await deps.ledger
      .updateRun(run.id, { errorKind: 'provision', errorMessage: message })
      .catch(() => {});
    await deps.ledger
      .appendEvent(run.id, 'error', { stage: 'worktree', message })
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
  const workspaceId = run.daemonWorkspaceId ?? run.id;
  await deps.daemon.deleteWorktree(workspaceId, {
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
