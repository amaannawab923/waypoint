/**
 * Waypoint main's client for the agent-runs ledger — the backend's
 * `/agent-runs` routes (waypoint-backend/src/routes/agentRuns.routes.ts,
 * ROAD-54). One thin typed function per route, the same posture as
 * `copilot/proposalApproval.ts`'s `post()`: a failure arrives as a rejected
 * promise carrying the backend's own sentence, which is what every caller
 * here wants to log or show.
 *
 * Why main and not the renderer: the run modules that write to the ledger
 * (worktree provisioning, boot-time reconcile) run in main, on the daemon's
 * schedule, not the user's. The renderer reads runs through the ordinary
 * `data/api.ts` path later (W3); nothing here is a second HTTP client for
 * it to use.
 */

export type AgentRunStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'blocked'
  | 'finishing'
  | 'needs-review'
  | 'done'
  | 'interrupted'
  | 'failed'
  | 'cancelled';

export type AgentRunEntry = 'independent' | 'dispatched';

/** The row as the backend serialises it (timestamps as ISO strings). */
export interface AgentRun {
  id: string;
  projectId: string;
  ticketId: string | null;
  ownerMemberId: string;
  agentId: string | null;
  entry: AgentRunEntry;
  providerId: string;
  daemonWorkspaceId: string | null;
  daemonSessionId: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseRef: string | null;
  prUrl: string | null;
  status: AgentRunStatus;
  blockedReason: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  summary: string | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string | null;
  retryOfRunId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface AgentRunEvent {
  runId: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface CreateAgentRunInput {
  projectId: string;
  ticketId?: string | null;
  ownerMemberId: string;
  agentId?: string | null;
  entry: AgentRunEntry;
  providerId: string;
  baseRef?: string;
  retryOfRunId?: string;
}

/** Mirrors updateAgentRunSchema — every field optional, at least one sent. */
export interface UpdateAgentRunInput {
  status?: AgentRunStatus;
  reason?: string;
  blockedReason?: string | null;
  errorKind?: string | null;
  errorMessage?: string | null;
  summary?: string | null;
  daemonWorkspaceId?: string | null;
  daemonSessionId?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  baseRef?: string | null;
  prUrl?: string | null;
  turnCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export type ClientEventKind =
  | 'worktree_created'
  | 'worktree_removed'
  | 'session_started'
  | 'session_resumed'
  | 'session_ended'
  | 'prompt_sent'
  | 'turn_completed'
  | 'permission_requested'
  | 'permission_answered'
  | 'proposal_created'
  | 'pushed'
  | 'pr_opened'
  | 'error'
  | 'note';

export interface ListAgentRunsQuery {
  projectId?: string;
  ownerMemberId?: string;
  ticketId?: string;
  status?: AgentRunStatus[];
  limit?: number;
  cursor?: string;
}

export interface RunPage {
  items: AgentRun[];
  nextCursor: string | null;
}

export interface LedgerClient {
  createRun(input: CreateAgentRunInput): Promise<AgentRun>;
  getRun(id: string): Promise<AgentRun | null>;
  listRuns(query: ListAgentRunsQuery): Promise<RunPage>;
  /** Every page of `listRuns`, for the callers (reconcile) that need all of a filter. */
  listAllRuns(query: Omit<ListAgentRunsQuery, 'cursor'>): Promise<AgentRun[]>;
  updateRun(id: string, patch: UpdateAgentRunInput): Promise<AgentRun>;
  appendEvent(
    id: string,
    kind: ClientEventKind,
    payload?: Record<string, unknown>,
  ): Promise<AgentRunEvent>;
}

/**
 * Thrown for a non-2xx answer. `status` is the HTTP status; `message` is
 * the backend's sentence when it sent one (a 409 from the status machine
 * is exactly that), else a generic line naming the path.
 */
export class LedgerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerRequestError';
  }
}

export interface LedgerClientDeps {
  /** Defaults to WAYPOINT_API_BASE_URL or the backend's own 14000. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

// The same fallback claudeSession.ts and proposalApproval.ts use — 14000,
// not Express's conventional 4000, matching waypoint-backend's default.
function defaultBaseUrl(): string {
  return process.env.WAYPOINT_API_BASE_URL || 'http://localhost:14000';
}

// Every id that reaches a URL path — lib/ids.ts's shape, a prefix, a
// hyphen, then alphanumerics — the rule proposalApproval.ts applies to its
// own ids and for the same reason: an id is not a value to take on trust
// from a caller, even one inside this process.
const RUN_ID = /^[a-z]+-[A-Za-z0-9]{1,64}$/;

function assertRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new Error(`Not a run id: ${JSON.stringify(id)}`);
}

export function createLedgerClient(deps: LedgerClientDeps = {}): LedgerClient {
  const baseUrl = (deps.baseUrl ?? defaultBaseUrl()).replace(/\/$/, '');
  // Resolved per call, not at construction: the global `fetch` is
  // Electron main's at runtime but is absent in the jest environment that
  // imports engineIpc.ts, and a client nobody calls must cost nothing.
  const doFetch: typeof fetch = (input, init) =>
    (deps.fetch ?? fetch)(input, init);

  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let message = `Request failed: ${response.status} ${method} ${path}`;
      try {
        const errorBody = (await response.json()) as { error?: unknown };
        if (errorBody?.error) {
          message =
            typeof errorBody.error === 'string'
              ? errorBody.error
              : JSON.stringify(errorBody.error);
        }
      } catch {
        // no JSON error body — keep the generic message
      }
      throw new LedgerRequestError(response.status, message);
    }
    return { status: response.status, body: (await response.json()) as T };
  }

  function listQuery(query: ListAgentRunsQuery): string {
    const params = new URLSearchParams();
    if (query.projectId) params.set('projectId', query.projectId);
    if (query.ownerMemberId) params.set('ownerMemberId', query.ownerMemberId);
    if (query.ticketId) params.set('ticketId', query.ticketId);
    if (query.status?.length) params.set('status', query.status.join(','));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  const client: LedgerClient = {
    async createRun(input) {
      return (await request<AgentRun>('POST', '/agent-runs', input)).body;
    },
    async getRun(id) {
      assertRunId(id);
      try {
        return (await request<AgentRun>('GET', `/agent-runs/${id}`)).body;
      } catch (error) {
        if (error instanceof LedgerRequestError && error.status === 404)
          return null;
        throw error;
      }
    },
    async listRuns(query) {
      return (await request<RunPage>('GET', `/agent-runs${listQuery(query)}`))
        .body;
    },
    async listAllRuns(query) {
      const items: AgentRun[] = [];
      let cursor: string | undefined;
      // Bounded: reconcile asks for the handful of runs that think they
      // are live; a ledger with more than 100 pages of those is a bug to
      // surface, not a loop to run forever.
      for (let page = 0; page < 100; page += 1) {
        const result = await client.listRuns({ ...query, limit: 100, cursor });
        items.push(...result.items);
        if (!result.nextCursor) return items;
        cursor = result.nextCursor;
      }
      throw new Error(
        'listAllRuns: more than 100 pages; refusing to keep paging',
      );
    },
    async updateRun(id, patch) {
      assertRunId(id);
      return (await request<AgentRun>('PATCH', `/agent-runs/${id}`, patch))
        .body;
    },
    async appendEvent(id, kind, payload) {
      assertRunId(id);
      return (
        await request<AgentRunEvent>('POST', `/agent-runs/${id}/events`, {
          kind,
          ...(payload ? { payload } : {}),
        })
      ).body;
    },
  };
  return client;
}
