import * as path from 'node:path';
import { EngineCallError, type WireClient } from '../types';

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

/** `@emdash/shared`'s stableStringify: JSON with object keys sorted, recursively. */
function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function liveTopic(stateId: string, key?: unknown): string {
  return key === undefined ? stateId : `${stateId}|${stableStringify(key)}`;
}

/**
 * One snapshot of a live topic: attach, take the first snapshot, detach.
 * The daemon replies to `snapshot` with `{generation, sequence, timestamp,
 * data}`; callers get `data`.
 */
export async function readSnapshot<T>(
  client: WireClient,
  topic: string,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let detach: (() => void) | null = null;
    let released = false;
    // Detach exactly once, and only once `detach` is known: a snapshot can
    // arrive before the attach promise resolves (the two race — see
    // wire/client.ts's header), so whichever of the two happens second is
    // the one that actually releases the topic.
    const release = () => {
      if (released || !detach) return;
      released = true;
      detach();
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      queueMicrotask(release);
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new DaemonApiError(
              topic,
              null,
              `No snapshot of ${topic} within ${timeoutMs}ms`,
            ),
          ),
        ),
      timeoutMs,
    );
    client
      .attach(topic, {
        onSnapshot: (value) => {
          const envelope = value as { data?: T } | null;
          finish(() =>
            resolve(
              (envelope && 'data' in envelope ? envelope.data : value) as T,
            ),
          );
        },
        onUpdate: () => {},
        onError: (error, retrying) => {
          if (!retrying)
            finish(() =>
              reject(
                new DaemonApiError(
                  topic,
                  error,
                  `Topic ${topic} failed: ${describe(error)}`,
                ),
              ),
            );
        },
      })
      .then((unsubscribe) => {
        detach = unsubscribe;
        if (settled) release();
      })
      .catch((error) => finish(() => reject(error)));
  });
}

export function createDaemonRunsApi(client: WireClient): DaemonRunsApi {
  async function fallible<T>(
    procedure: string,
    input: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    let answer: Fallible<T>;
    try {
      answer = await client.call<Fallible<T>>(
        procedure,
        input,
        timeoutMs ? { timeoutMs } : undefined,
      );
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
    createWorktree(request) {
      // The daemon inspects, resolves the base, adds the worktree and
      // verifies before answering — seconds on a large repo, longer if
      // the base ref needs a fetch. Well past the client's default call
      // timeout, so name one.
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
    async killSession(conversationId) {
      await fallible<void>('acp.kill', { conversationId });
    },
  };
}
