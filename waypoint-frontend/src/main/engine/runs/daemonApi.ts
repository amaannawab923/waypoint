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
 *   acp.start                           {conversationId, providerId, cwd, sessionId, model}
 *     → {success:true, data:{sessionId}}   sessionId = the provider's own handle; with
 *                                          `sessionId` set the daemon loadSessions it and,
 *                                          if the provider cannot, starts fresh in the same
 *                                          cwd and answers a NEW sessionId (W4 QA, 2026-09-12)
 *     → {success:false, error:{type:'auth-required'|'spawn-failed'|'new-session-failed'|…}}
 *   acp.sendPrompt                      {conversationId, prompt:{text, hiddenContext?}, placement?}
 *     → {success:true, data:{queued}}    resolves when the TURN ends, not when it is queued;
 *                                          hiddenContext reaches the agent with the prompt and
 *                                          is not a transcript item of its own (never echoed
 *                                          by acp.getHistory — the message item carries
 *                                          kind, id, seq, role, text, attachments only)
 *   acp.getHistory                      {conversationId, limit, before?}
 *     → {success:true, data:{turns, nextCursor}}   the latest `limit` COMMITTED turns, oldest
 *                                          first; an item is {kind:'message', role, text} |
 *                                          thinking | tool…; a turn's `outcome` is
 *                                          {kind:'done'|'error'|'cancelled'|'interrupted'}
 *   acp.kill                            {conversationId} → {success:true} | {success:false, error}
 *
 * `acp.start` also takes `env` (W5a): merged LAST over the daemon's
 * allowlisted agent env (plugin-host.ts `buildAcpSpawn`), so a key set to
 * '' here reaches the agent process empty even when the allowlist would
 * have passed the shell's value through.
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
  /** Prompts waiting for the current turn to end (W5a: a turn has ended only when this is 0 too). */
  queuedPromptCount?: number;
  /** The provider's reason for the last turn's end; `end_turn` is the ordinary one. */
  lastStopReason?:
    | 'end_turn'
    | 'max_tokens'
    | 'max_turn_requests'
    | 'refusal'
    | 'cancelled'
    | null;
  /** The last turn settled as an error (prompt failed, process closed…). */
  lastTurnErrored?: boolean;
  /** When the agent last produced output; absent before its first. */
  lastOutputAt?: number;
  lastInputAt?: number;
}

/** One committed turn of a session's history, the parts finalize reads. */
export interface DaemonTranscriptTurn {
  id: string;
  seq: number;
  initiator: unknown;
  items: Array<
    | { kind: 'message'; role: 'user' | 'assistant'; text: string }
    | { kind: string; [key: string]: unknown }
  >;
  outcome?: {
    kind: 'done' | 'cancelled' | 'error' | 'interrupted';
    reason?: string;
  };
}

export interface CreateWorktreeRequest {
  /** The daemon record id for the new worktree — the run id, so reconcile matches on it. */
  workspaceId: string;
  repositoryId: string;
  branch: string;
  baseRef: string;
  path: string;
}

/**
 * What `conversations.create` needs to register a run in the daemon's own
 * conversation index (spec §3.4/§4.1) — the durable store the ACP runtime's
 * lifecycle reports (`session-started`, `session-activity`, `session-ended`)
 * are written into. The ACP component is wired to the reports-only subset of
 * that contract and cannot self-register, so without this call first every
 * report for the conversation is rejected by the index as
 * `conversation-not-found` (the daemon logs a warning per report, and the
 * index — what emdash's own UI lists and resumes from — never has the run).
 * Waypoint's own view of a session's end does not go through the index: the
 * ledger follower watches `acp.sessions.list` (liveLedgerFollower.ts), so
 * this is hygiene for the daemon, not the fix for a run that stays
 * `running` (review of PR #86).
 *
 * `createdAt` is one of the index's IMMUTABLE fields (with provider, type,
 * cwd, workspacePath, idRegime): a second create for the same id must carry
 * the same value, so callers pass the run's own creation time, never "now".
 */
export interface CreateConversationRequest {
  conversationId: string;
  providerId: string;
  cwd: string;
  /** The run's creation time (epoch ms) — immutable in the index, so the same on every call. */
  createdAt: number;
  title: string | null;
}

/** What `createConversation` found: a record was made, or one already existed (possibly disagreeing on an immutable field). */
export interface CreateConversationResult {
  /** Immutable fields whose stored value differs from this request's — empty when the record was created or matches. */
  mismatch: string[];
}

export interface StartSessionRequest {
  conversationId: string;
  providerId: string;
  cwd: string;
  /** The provider's session to load; null starts a new one. */
  sessionId: string | null;
  /** A session mode the provider offers (`bypassPermissions` for auto-approve, W4b); null = the provider's default. */
  modeId?: string | null;
  /** Prompts the daemon delivers once the session is ready — the dialog's first message (W4b), or an outbox drained into a start (never-lock). */
  initialQueue?: Array<{ text: string; hiddenContext?: string }>;
  /**
   * Environment overrides for the agent process, applied over the daemon's
   * own allowlisted env (W5a §2.5: credentials set to '' for an
   * auto-approved writing session).
   */
  env?: Record<string, string>;
}

/** `git.repository.model.refs` as this module reads it. */
export interface RepositoryRefs {
  branches: string[];
  /** The branch `origin/HEAD` (or another remote's) points at, when known. */
  remoteHeads: Array<{ remote: string; branch: string }>;
}

/** The daemon's `agentConfig.saveMcpServer` input (emdash `mcpServerSchema`), the stdio half. */
export interface DaemonMcpServer {
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Provider ids the server is written for (`claude`). */
  providers: string[];
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
  /**
   * Registers (or overwrites, by name) an MCP server in each named
   * provider's own config — for `claude`, `~/.claude.json` — the way
   * emdash's MCP settings page does; every session that provider starts
   * afterwards lists it. See runs/sessionBrowser.ts for the one caller and
   * the gap it accepts (the daemon reads the person's real home).
   */
  saveMcpServer(server: DaemonMcpServer): Promise<void>;
  /** Local branches plus what the remotes' HEADs point at. */
  listRefs(repoPath: string): Promise<RepositoryRefs>;
  /**
   * Registers the run in the daemon's conversation index — see
   * `CreateConversationRequest`'s own comment for why this happens before
   * `startSession`. Idempotent for the same run: the contract's only error
   * is `immutable-field-mismatch` against an existing record with the same
   * id, which this resolves as "already registered" and reports through
   * `mismatch` (empty for a record that agrees) rather than throwing — the
   * record exists either way, which is all the reports need. Throws like
   * every other call here on a real failure; callers treat it as
   * best-effort (catch and log, then still start the session): a run
   * missing from the daemon's index is recoverable, refusing to start it
   * over a registration hiccup is not.
   */
  createConversation(
    request: CreateConversationRequest,
  ): Promise<CreateConversationResult>;
  /**
   * Starts (or, with `sessionId`, loads) the ACP session for a run. The
   * daemon takes minutes on a cold provider start (spawning the agent,
   * initialising, the first newSession), so this names its own deadline.
   */
  startSession(request: StartSessionRequest): Promise<{ sessionId: string }>;
  /**
   * A prompt for the session. Answers when the daemon has taken the
   * prompt (PROMPT_ACCEPTED_MS), not when the turn ends: the call's own
   * promise is deliberately not awaited past `queued`. `hiddenContext`
   * (never-lock) is Waypoint's framing for the agent — the resume note,
   * the continuation note — delivered with the person's own words and
   * never a transcript message of its own.
   */
  sendPrompt(
    conversationId: string,
    text: string,
    hiddenContext?: string,
  ): Promise<void>;
  /**
   * The latest `limit` committed turns of a session, oldest first — what
   * host-side finalize reads the closing message from (W5a §2.4).
   */
  getHistory(
    conversationId: string,
    limit: number,
  ): Promise<DaemonTranscriptTurn[]>;
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
/** A cold `acp.start` spawns the agent and waits for its first session. */
export const START_SESSION_TIMEOUT_MS = 3 * 60_000;
/** The resume note's turn may run long; the call is bounded regardless. */
export const SEND_PROMPT_TIMEOUT_MS = 10 * 60_000;
/** After this, the note is taken as accepted even though the turn has not ended. */
export const PROMPT_ACCEPTED_MS = 2_000;

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

  async function listRefs(repoPath: string): Promise<RepositoryRefs> {
    const refs = await readSnapshot<{
      branches: Array<{ type: string; branch: string }>;
      remoteHeads?: Array<{ remote: string; branch: string }>;
    }>(
      client,
      liveTopic('git.repository.model.refs', {
        repository: hostAbsolutePath(repoPath),
      }),
    );
    return {
      branches: refs.branches
        .filter((b) => b.type === 'local')
        .map((b) => b.branch),
      remoteHeads: refs.remoteHeads ?? [],
    };
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
      return (await listRefs(repoPath)).branches;
    },
    async saveMcpServer(server) {
      await fallible<unknown>('agentConfig.saveMcpServer', { server });
    },
    listRefs,
    async createConversation(request) {
      try {
        await fallible<unknown>('conversations.create', {
          conversationId: request.conversationId,
          provider: request.providerId,
          type: 'acp',
          cwd: request.cwd,
          workspacePath: request.cwd,
          idRegime: 'provider-minted',
          createdAt: request.createdAt,
          title: request.title ?? '',
          config: { version: '1', type: 'acp' },
        });
        return { mismatch: [] };
      } catch (error) {
        const detail =
          error instanceof DaemonApiError
            ? (error.detail as { type?: string; fields?: unknown })
            : null;
        if (detail?.type === 'immutable-field-mismatch') {
          return {
            mismatch: Array.isArray(detail.fields)
              ? detail.fields.filter((f): f is string => typeof f === 'string')
              : [],
          };
        }
        throw error;
      }
    },
    startSession(request) {
      const { modeId, initialQueue, env, ...rest } = request;
      return fallible<{ sessionId: string }>(
        'acp.start',
        {
          ...rest,
          model: null,
          modeId: modeId ?? null,
          ...(initialQueue && initialQueue.length ? { initialQueue } : {}),
          ...(env && Object.keys(env).length ? { env } : {}),
        },
        START_SESSION_TIMEOUT_MS,
      );
    },
    async getHistory(conversationId, limit) {
      const page = await fallible<{ turns: DaemonTranscriptTurn[] }>(
        'acp.getHistory',
        { conversationId, limit },
      );
      return page.turns ?? [];
    },
    async sendPrompt(conversationId, text, hiddenContext) {
      // The daemon answers `acp.sendPrompt` when the turn ends. A prompt
      // only needs to be taken, so the first of "the turn ended" and
      // "PROMPT_ACCEPTED_MS passed with no refusal" wins; a refusal inside
      // that window is still a rejection. The late outcome is observed
      // (never an unhandled rejection) and dropped.
      const turn = fallible<{ queued: boolean }>(
        'acp.sendPrompt',
        {
          conversationId,
          prompt: { text, ...(hiddenContext ? { hiddenContext } : {}) },
          placement: 'auto',
        },
        SEND_PROMPT_TIMEOUT_MS,
      ).then(() => undefined);
      turn.catch(() => {});
      await Promise.race([
        turn,
        new Promise<void>((resolve) => {
          setTimeout(resolve, PROMPT_ACCEPTED_MS).unref?.();
        }),
      ]);
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
