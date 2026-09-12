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
  /** Null for an independent run on a folder that is no project's repository (W4b). */
  projectId: string | null;
  ticketId: string | null;
  ownerMemberId: string;
  agentId: string | null;
  entry: AgentRunEntry;
  providerId: string;
  /** What the user called it in the New session dialog (W4); null when nothing. */
  title: string | null;
  /** Where the agent works (W4b): a fresh worktree Waypoint owns, or the picked folder itself. */
  isolation: 'worktree' | 'directory';
  /** The directory the agent runs in, once known: the worktree's path or the folder. */
  cwd: string | null;
  /** Started in the provider's bypass-permissions mode: the session asks nothing. */
  autoApprove: boolean;
  /** The provider mode the session was started in (`plan`, `bypassPermissions`); null = the provider's default. */
  modeId: string | null;
  /** What a dispatched run was asked to do (W5a); null for an independent run. */
  intent: 'investigate' | 'fix' | 'custom' | null;
  /** The Copilot conversation the run was dispatched from, when there was one. */
  copilotConversationId: string | null;
  daemonWorkspaceId: string | null;
  daemonSessionId: string | null;
  /** The provider's own resume handle, as `acp.start` answered it (W4, ROAD-69). */
  providerSessionId: string | null;
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
  projectId: string | null;
  ticketId?: string | null;
  ownerMemberId: string;
  agentId?: string | null;
  entry: AgentRunEntry;
  providerId: string;
  baseRef?: string;
  title?: string | null;
  isolation?: 'worktree' | 'directory';
  autoApprove?: boolean;
  modeId?: string | null;
  intent?: 'investigate' | 'fix' | 'custom';
  copilotConversationId?: string | null;
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
  providerSessionId?: string | null;
  title?: string | null;
  cwd?: string | null;
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

/** The slice of a ticket a brief is built from (the backend's `/tickets/:id`). */
export interface LedgerTicket {
  id: string;
  /** `ROAD-116`. */
  identifier: string;
  title: string;
  /** Markdown/plain text as the ticket stores it; null when empty. */
  description: string | null;
  projectId: string;
  stateId: string | null;
  priority: string | null;
}

export interface LedgerComment {
  id: string;
  authorId: string;
  /** The comment body as stored; HTML for a typed comment. */
  bodyHtml: string;
  createdAt: string;
}

export interface LedgerState {
  id: string;
  projectId: string;
  name: string;
  group:
    'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled' | string;
  sortOrder: number;
}

export interface LedgerMember {
  id: string;
  fullName: string;
  displayName: string | null;
}

/** A proposal as `/tickets/:id/proposals` lists it — the fields Fix seeding reads. */
export interface LedgerProposal {
  id: string;
  kind: string;
  status: string;
  origin: 'copilot' | 'agent_run' | string;
  agentRunId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
}

export type CreateRunProposalInput =
  { kind: 'comment'; body: string } | { kind: 'state_change'; stateId: string };

/** The slice of a project a run start needs (the backend's `/projects/:id`). */
export interface LedgerProject {
  id: string;
  name: string;
  /** The linked local git checkout; null when the project has none. */
  repoPath: string | null;
}

export interface LedgerClient {
  /**
   * The project a run is about to be started in — read by main, so the
   * renderer never names a path (W4). Null when there is no such project.
   */
  getProject(id: string): Promise<LedgerProject | null>;
  /** Every project, for matching a picked folder to its linked repository (W4b). */
  listProjects(): Promise<LedgerProject[]>;
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
  // --- W5a: what a dispatched run is built from and files back -----------
  /** The ticket a session is about to be dispatched on; null when there is none. */
  getTicket(id: string): Promise<LedgerTicket | null>;
  /** The ticket's comments, oldest first. */
  listComments(ticketId: string): Promise<LedgerComment[]>;
  /** The project's workflow states, for the state change Fix files. */
  listStates(projectId: string): Promise<LedgerState[]>;
  /** Every member, for naming comment authors in the brief. */
  listMembers(): Promise<LedgerMember[]>;
  /** Every proposal on the ticket, any status — Fix seeds from the approved RCA among them. */
  listTicketProposals(ticketId: string): Promise<LedgerProposal[]>;
  /** Files a proposal from a run (origin `agent_run`); lands in Review. Answers the proposal's id. */
  createRunProposal(
    runId: string,
    input: CreateRunProposalInput,
  ): Promise<{ id: string }>;
  /**
   * A Waypoint-authored system note in the Copilot conversation the run
   * came from, else the member's latest. Answers false when there was no
   * conversation to post to (the backend's 204) — not an error.
   */
  postCopilotNote(runId: string, content: string): Promise<boolean>;
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
  /** Per-request deadline; defaults to LEDGER_TIMEOUT_MS. */
  timeoutMs?: number;
}

export const LEDGER_TIMEOUT_MS = 15_000;

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

/** Project ids share the shape (`proj-…`), and reach a URL the same way. */
export function assertRunId(id: string): void {
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
    // A backend that accepts and never answers must not pin reconcile
    // (found in review, round 2); the ledger answers in milliseconds. An
    // AbortController rather than AbortSignal.timeout: the latter is not
    // in every runtime this file is loaded in (jsdom), and the effect is
    // the same.
    const abort = new AbortController();
    const timer = setTimeout(
      () =>
        abort.abort(new Error(`Ledger request timed out: ${method} ${path}`)),
      deps.timeoutMs ?? LEDGER_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers:
          body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
    } finally {
      clearTimeout(timer);
    }
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
    // A 204 (the notes route with nowhere to post) has no body to parse.
    if (response.status === 204) {
      return { status: response.status, body: undefined as unknown as T };
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
    async getProject(id) {
      assertRunId(id);
      try {
        const project = (
          await request<{ id: string; name: string; repoPath?: string | null }>(
            'GET',
            `/projects/${id}`,
          )
        ).body;
        return {
          id: project.id,
          name: project.name,
          repoPath: project.repoPath ?? null,
        };
      } catch (error) {
        if (error instanceof LedgerRequestError && error.status === 404)
          return null;
        throw error;
      }
    },
    async listProjects() {
      const projects = (
        await request<
          Array<{ id: string; name: string; repoPath?: string | null }>
        >('GET', '/projects')
      ).body;
      return (Array.isArray(projects) ? projects : []).map((p) => ({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath ?? null,
      }));
    },
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
    async getTicket(id) {
      assertRunId(id);
      try {
        const t = (
          await request<{
            id: string;
            identifier: string;
            title: string;
            description?: string | null;
            projectId: string;
            stateId?: string | null;
            priority?: string | null;
          }>('GET', `/tickets/${id}`)
        ).body;
        return {
          id: t.id,
          identifier: t.identifier,
          title: t.title,
          description: t.description ?? null,
          projectId: t.projectId,
          stateId: t.stateId ?? null,
          priority: t.priority ?? null,
        };
      } catch (error) {
        if (error instanceof LedgerRequestError && error.status === 404)
          return null;
        throw error;
      }
    },
    async listComments(ticketId) {
      assertRunId(ticketId);
      const rows = (
        await request<LedgerComment[]>('GET', `/tickets/${ticketId}/comments`)
      ).body;
      return Array.isArray(rows) ? rows : [];
    },
    async listStates(projectId) {
      assertRunId(projectId);
      const rows = (
        await request<LedgerState[]>(
          'GET',
          `/states?projectId=${encodeURIComponent(projectId)}`,
        )
      ).body;
      return Array.isArray(rows) ? rows : [];
    },
    async listMembers() {
      const rows = (await request<LedgerMember[]>('GET', '/members')).body;
      return Array.isArray(rows) ? rows : [];
    },
    async listTicketProposals(ticketId) {
      assertRunId(ticketId);
      const body = (
        await request<{ proposals?: LedgerProposal[] }>(
          'GET',
          `/tickets/${ticketId}/proposals`,
        )
      ).body;
      return Array.isArray(body?.proposals) ? body.proposals : [];
    },
    async createRunProposal(runId, input) {
      assertRunId(runId);
      const created = (
        await request<{ id: string }>(
          'POST',
          `/agent-runs/${runId}/proposals`,
          input,
        )
      ).body;
      return { id: created.id };
    },
    async postCopilotNote(runId, content) {
      assertRunId(runId);
      const { status } = await request<unknown>('POST', '/copilot/notes', {
        runId,
        content,
      });
      return status !== 204;
    },
  };
  return client;
}
