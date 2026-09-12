import * as path from 'node:path';
import { EngineCallError, type WireClient } from '../types';
import { liveTopic } from '../wire/topics';

export { liveTopic } from '../wire/topics';

/**
 * The slice of the daemon the run modules need, as one typed facade over
 * the raw Wire client — ROAD-55 (worktrees) and ROAD-57 (reconcile).
 *
 * Every procedure path, input shape and answer shape here was observed
 * live against the pinned daemon (scripts/qa probe, 2026-09-12) rather
 * than read off the contract alone:
 *
 *   workspaceRegistry.createWorkspace   {workspaceId, path}
 *     → {success:true, data: record}
 *     → {success:false, error:{type:'already-registered', record}}  same path, other id
 *   workspaceRegistry.createWorktree    {workspaceId, repositoryId, branch, baseRef, path, preservePatterns}
 *     → {success:true, data: record}   record.path is CANONICAL (/private/tmp/…), not the requested path
 *     → {success:false, error:{type:'stage-failed', stage:'add-worktree', message}}  branch checked out elsewhere
 *   workspaceRegistry.deleteWorktree    {workspaceId, deleteBranch}
 *     → {success:true}                 idempotent: an absent id is success
 *   git.repository.model.refs           live model keyed by a STRUCTURED path
 *     topic 'git.repository.model.refs|{"repository":{"root":{"kind":"posix"},"segments":[…]}}'
 *     snapshot {generation, sequence, timestamp, data:{branches:[{type:'local'|'remote', branch, oid}], …}}
 *   acp.sessions.list                   snapshot data: Record<conversationId, SessionSummary>
 *   acp.kill                            {conversationId} → {success:true} | {success:false, error}
 *
 * Nothing in here decides anything: it asks, and hands back what the
 * daemon said, as typed data or a thrown DaemonApiError.
 */

/** The daemon's workspace-registry record, the fields runs read. */
export interface DaemonWorkspaceRecord {
  id: string;
  kind: 'repository' | 'worktree' | 'directory';
  /** Canonical on disk — realpath'd by the daemon. */
  path: string;
  parentId: string | null;
  observedStatus: 'present' | 'missing';
  creation: {
    branch: string;
    baseRef: string | null;
    requestedPath: string;
  } | null;
  /** Durable lifecycle steps; `copy-artifacts` appears only when patterns were resolved. */
  lifecycle?: { steps: Array<{ id: string; status: string }> } | null;
  lastCreateOutcome:
    | { status: 'started'; at: number }
    | { status: 'succeeded'; at: number }
    | { status: 'failed'; at: number; stage: string; message: string }
    | null;
}

/** One live ACP session as `acp.sessions.list` summarises it. */
export interface DaemonSessionSummary {
  conversationId: string;
  providerId: string;
  cwd?: string;
  lifecycle: unknown;
  isGenerating: boolean;
  pendingPermissionCount: number;
  updatedAt: number;
}

export interface CreateWorktreeRequest {
  /** The daemon record id for the new worktree — the run id, so reconcile matches on it. */
  workspaceId: string;
  repositoryId: string;
  branch: string;
  baseRef: string;
  path: string;
}

export interface DaemonRunsApi {
  /**
   * Registers the repository at `repoPath` under `preferredId`, or returns
   * the record already registered for that path under whatever id it has.
   */
  registerRepository(
    preferredId: string,
    repoPath: string,
  ): Promise<DaemonWorkspaceRecord>;
  /**
   * Sets the repository's personal `preservePatterns` to `[]` in this
   * daemon's config layer, so no gitignored artifact is copied into a
   * worktree created from it (the request field is ignored by the pinned
   * daemon; the personal layer beats the repo's `.emdash.json`).
   */
  disableArtifactCopy(repositoryId: string): Promise<void>;
  createWorktree(
    request: CreateWorktreeRequest,
  ): Promise<DaemonWorkspaceRecord>;
  deleteWorktree(
    workspaceId: string,
    options: { deleteBranch: boolean },
  ): Promise<void>;
  /** Local branch names of the repository at `repoPath`. */
  listLocalBranches(repoPath: string): Promise<string[]>;
  /** Every worktree record the daemon holds, by id. */
  listWorkspaceRecords(): Promise<Record<string, DaemonWorkspaceRecord>>;
  listSessions(): Promise<Record<string, DaemonSessionSummary>>;
  /** Asks the agent to stop its current turn; the session stays alive. */
  cancelTurn(conversationId: string): Promise<void>;
  killSession(conversationId: string): Promise<void>;
}

/** A daemon procedure answered `success:false`, or a snapshot never came. */
export class DaemonApiError extends Error {
  constructor(
    readonly procedure: string,
    readonly detail: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonApiError';
  }
}

type Fallible<T> =
  { success: true; data: T } | { success: false; error: unknown };

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { type?: unknown; stage?: unknown; message?: unknown };
    const parts = [e.type, e.stage, e.message].filter(
      (p) => typeof p === 'string',
    );
    if (parts.length) return parts.join(': ');
  }
  return JSON.stringify(error);
}

/**
 * The daemon's structured host path: posix root plus segments. What the
 * git runtime's `repository` selector wants, and what `encodeTopic` sorts
 * into the live-model key. Only posix here — Apple Silicon first (ROAD-101);
 * the Windows drive root is ROAD-102's.
 */
export function hostAbsolutePath(absolute: string): {
  root: { kind: 'posix' };
  segments: string[];
} {
  const normalized = path.posix.normalize(absolute);
  if (!normalized.startsWith('/'))
    throw new Error(`Not an absolute path: ${absolute}`);
  return {
    root: { kind: 'posix' },
    segments: normalized.split('/').filter(Boolean),
  };
}

/**
 * One snapshot of a live topic, read with a bare `snapshot` request —
 * no attachment. The daemon answers it from the topic's source whether
 * or not anyone is attached, and (found in review, round 2) the Wire
 * client refuses a second attach on a topic it already holds, so the
 * first draft's attach-to-read collided with any subscriber of the same
 * topic. The daemon replies `{generation, sequence, timestamp, data}`;
 * callers get `data`.
 */
export async function readSnapshot<T>(
  client: WireClient,
  topic: string,
  timeoutMs = SNAPSHOT_TIMEOUT_MS,
): Promise<T> {
  let envelope: { data?: T } | null | undefined;
  try {
    envelope = await client.snapshot<{ data?: T }>(topic, { timeoutMs });
  } catch (error) {
    if (error instanceof EngineCallError) {
      throw new DaemonApiError(
        topic,
        error,
        `Snapshot of ${topic} failed: ${error.message}`,
      );
    }
    throw error;
  }
  return (
    envelope && typeof envelope === 'object' && 'data' in envelope
      ? envelope.data
      : envelope
  ) as T;
}

/** A snapshot is answered from memory; ten seconds is a daemon that is wedged. */
export const SNAPSHOT_TIMEOUT_MS = 10_000;
/**
 * Every procedure here gets a deadline (found in review, round 2: the
 * comment claimed a client default that did not exist, and an `acp.kill`
 * a wedged daemon never answered pinned boot reconcile for the process
 * lifetime). Registering a repository and killing a session are quick;
 * creating a worktree and deleting one are not, and name their own.
 */
export const CALL_TIMEOUT_MS = 30_000;

export function createDaemonRunsApi(client: WireClient): DaemonRunsApi {
  async function fallible<T>(
    procedure: string,
    input: unknown,
    timeoutMs: number = CALL_TIMEOUT_MS,
  ): Promise<T> {
    let answer: Fallible<T>;
    try {
      answer = await client.call<Fallible<T>>(procedure, input, { timeoutMs });
    } catch (error) {
      if (error instanceof EngineCallError) {
        throw new DaemonApiError(
          procedure,
          error,
          `${procedure}: ${error.message}`,
        );
      }
      throw error;
    }
    if (!answer.success)
      throw new DaemonApiError(
        procedure,
        answer.error,
        `${procedure}: ${describe(answer.error)}`,
      );
    return answer.data;
  }

  return {
    async registerRepository(preferredId, repoPath) {
      try {
        return await fallible<DaemonWorkspaceRecord>(
          'workspaceRegistry.createWorkspace',
          {
            workspaceId: preferredId,
            path: repoPath,
          },
        );
      } catch (error) {
        const detail =
          error instanceof DaemonApiError
            ? (error.detail as {
                type?: string;
                record?: DaemonWorkspaceRecord;
              })
            : null;
        if (detail?.type === 'already-registered' && detail.record)
          return detail.record;
        throw error;
      }
    },
    async disableArtifactCopy(repositoryId) {
      await fallible<unknown>('workspaceRegistry.patchPersonalProjectConfig', {
        workspaceId: repositoryId,
        patch: { preservePatterns: [] },
      });
    },
    createWorktree(request) {
      // The daemon inspects, resolves the base, adds the worktree and
      // verifies before answering — seconds on a large repo, longer if
      // the base ref needs a fetch. Well past CALL_TIMEOUT_MS, so name
      // its own.
      return fallible<DaemonWorkspaceRecord>(
        'workspaceRegistry.createWorktree',
        { ...request, preservePatterns: [] },
        5 * 60_000,
      );
    },
    async deleteWorktree(workspaceId, options) {
      await fallible<void>(
        'workspaceRegistry.deleteWorktree',
        { workspaceId, deleteBranch: options.deleteBranch },
        2 * 60_000,
      );
    },
    async listLocalBranches(repoPath) {
      const refs = await readSnapshot<{
        branches: Array<{ type: string; branch: string }>;
      }>(
        client,
        liveTopic('git.repository.model.refs', {
          repository: hostAbsolutePath(repoPath),
        }),
      );
      return refs.branches
        .filter((b) => b.type === 'local')
        .map((b) => b.branch);
    },
    listWorkspaceRecords() {
      return readSnapshot<Record<string, DaemonWorkspaceRecord>>(
        client,
        liveTopic('workspaceRegistry.records.list'),
      );
    },
    listSessions() {
      return readSnapshot<Record<string, DaemonSessionSummary>>(
        client,
        liveTopic('acp.sessions.list'),
      );
    },
    async cancelTurn(conversationId) {
      await fallible<void>('acp.cancelTurn', { conversationId });
    },
    async killSession(conversationId) {
      await fallible<void>('acp.kill', { conversationId });
    },
  };
}
