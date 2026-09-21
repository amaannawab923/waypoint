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

import type {
  PendingPrompt,
  PendingPromptReason,
  PendingPromptState,
  ResolvedTicket,
} from '../types';

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

/** Mirrors the backend's runVerdictSchema; report.ts's Verdict is the same set. */
export type RunVerdict =
  | 'root-cause'
  | 'fixed'
  | 'partial'
  | 'not-a-bug'
  | 'wont-fix'
  | 'delivered'
  | 'needs-info';

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
  /** What the session concluded, as finalize read it from its report (W5c); null until then. */
  verdict: RunVerdict | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string | null;
  retryOfRunId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** How many times reopenRun has continued this run (audit, never a throttle). */
  reopenCount: number;
  lastReopenedAt: string | null;
  /** Never-lock: how many times finalize has filed this run's report, and the branch HEAD it last filed at. */
  finalizeCount: number;
  finalizedHeadSha: string | null;
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
  verdict?: RunVerdict | null;
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
  finalizeCount?: number;
  finalizedHeadSha?: string | null;
}

export type ClientEventKind =
  | 'worktree_created'
  | 'worktree_removed'
  | 'session_started'
  | 'session_resumed'
  | 'session_ended'
  | 'prompt_sent'
  | 'prompt_queued'
  | 'prompt_dropped'
  | 'turn_completed'
  | 'permission_requested'
  | 'permission_answered'
  | 'proposal_created'
  | 'pushed'
  | 'pr_opened'
  | 'finalized'
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

/**
 * `groupId` ties the comment and the state change one closing message
 * files — `<runId>:<report sequence>` — so Review shows them as one card
 * and approves them together (customer feedback round 1).
 */
export type CreateRunProposalInput =
  | { kind: 'comment'; body: string; groupId?: string }
  | { kind: 'state_change'; stateId: string; groupId?: string };

/** The slice of a project a run start needs (the backend's `/projects/:id`). */
export interface LedgerProject {
  id: string;
  name: string;
  /** The linked local git checkout; null when the project has none. */
  repoPath: string | null;
}

// --- W5b: Jira issues in the ledger ----------------------------------------

/**
 * The prefix of a Jira issue's ledger handle — a `ticket_refs` row
 * (waypoint-backend/src/db/schema/integrations.ts). A run on a Jira issue
 * stores this id where a native run stores its `wi-…` ticket id; the
 * prefix alone says which system owns the ticket, the rule the backend's
 * `providerOf` applies to a proposal's ticket id.
 */
export const TICKET_REF_PREFIX = 'tref-';

/** Whether a run's `ticketId` names a Jira issue rather than a native ticket. */
export function isTicketRef(ticketId: string | null | undefined): boolean {
  return typeof ticketId === 'string' && ticketId.startsWith(TICKET_REF_PREFIX);
}

/** What a `tref-` handle stands for (the backend's `/ticket-refs/:id`): display data, never content. */
export interface LedgerTicketRef {
  id: string;
  provider: string;
  /** The Jira site's hostname the handle was minted against. */
  site: string | null;
  /** The issue key — `ENG-4`. */
  key: string;
  identifier: string;
  /** The summary as last seen; the brief reads the issue live. */
  title: string;
  url: string | null;
}

/** A typed key resolved in either system (the backend's `/tickets/resolve/:identifier`). */
export type { ResolvedTicket } from '../types';

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
  /**
   * Continues a run that is not live — needs-review, done, interrupted,
   * failed, cancelled — back to `provisioning` (never-lock): the one way
   * past updateRun's read-only guard on a terminal row. The backend keeps
   * only its workspace and owner checks; a LedgerRequestError(409) is a
   * live run (nothing to reopen) or another member's run.
   */
  reopenRun(
    id: string,
    reason?: string,
  ): Promise<{ run: AgentRun; from: AgentRunStatus }>;
  /**
   * Never-lock §3.3b: one publisher per ticket at publish time. Throws
   * LedgerRequestError(409) naming the writer that holds the ticket.
   */
  claimPublish(id: string, headSha: string | null): Promise<void>;
  /** The run's events, oldest first — what the transcript's markers are drawn from. */
  listEvents(
    id: string,
    options?: { afterSeq?: number },
  ): Promise<AgentRunEvent[]>;
  /** The run's transcript snapshot (ROAD-124), or null when none was ever saved. */
  getTranscript(
    id: string,
  ): Promise<{ turns: unknown[]; turnCount: number } | null>;
  // --- Never-lock: the per-run outbox ---------------------------------------
  listPendingPrompts(id: string): Promise<PendingPrompt[]>;
  createPendingPrompt(
    id: string,
    input: { text: string; reason: PendingPromptReason },
  ): Promise<PendingPrompt>;
  updatePendingPrompt(
    id: string,
    pendingId: string,
    patch: {
      state?: PendingPromptState;
      reason?: PendingPromptReason;
      autoAttempts?: number;
      lastError?: string | null;
    },
  ): Promise<PendingPrompt>;
  appendEvent(
    id: string,
    kind: ClientEventKind,
    payload?: Record<string, unknown>,
  ): Promise<AgentRunEvent>;
  // --- W5a: what a dispatched run is built from and files back -----------
  /** The ticket a session is about to be dispatched on; null when there is none. */
  getTicket(id: string): Promise<LedgerTicket | null>;
  /** The same by its `ROAD-116` identifier — what a person types in Copilot. */
  getTicketByIdentifier(identifier: string): Promise<LedgerTicket | null>;
  /** The ticket's comments, oldest first. */
  listComments(ticketId: string): Promise<LedgerComment[]>;
  /** The project's workflow states, for the state change Fix files. */
  listStates(projectId: string): Promise<LedgerState[]>;
  /** Every member, for naming comment authors in the brief. */
  listMembers(): Promise<LedgerMember[]>;
  /** Every proposal on the ticket, any status — Fix seeds from the approved RCA among them. */
  listTicketProposals(ticketId: string): Promise<LedgerProposal[]>;
  /**
   * Files a proposal from a run (origin `agent_run`); lands in Review.
   * Answers the proposal's id. For a run on a Jira issue (`external`) the
   * request carries the borrowed Jira credential header — the seam an
   * approve uses — so the backend can read the issue live and build the
   * external-write card; a native run's request carries nothing.
   */
  createRunProposal(
    runId: string,
    input: CreateRunProposalInput,
    options?: { external?: boolean },
  ): Promise<{ id: string }>;
  // --- W5b: Jira issues ---------------------------------------------------
  /** What a `tref-` handle stands for; null when there is no such ref. */
  getTicketRef(id: string): Promise<LedgerTicketRef | null>;
  /**
   * Mints (or refreshes) the handle for a Jira issue main has read itself
   * — the My Jira drawer's issue. The site is main's stored credential's,
   * never the renderer's.
   */
  rememberTicketRef(input: {
    site: string;
    key: string;
    title: string;
  }): Promise<LedgerTicketRef>;
  /**
   * A typed key (`ROAD-116`, `ENG-4`) to the ticket it names, in either
   * system — the MCP tool's dual lookup, with the borrowed credential so
   * the Jira half can answer. Null when neither has it; throws with the
   * backend's sentence when the key is ambiguous or Jira could not answer.
   */
  resolveTicket(identifier: string): Promise<ResolvedTicket | null>;
  /**
   * A Waypoint-authored system note in the Copilot conversation the run
   * came from, else the member's latest. Answers false when there was no
   * conversation to post to (the backend's 204) — not an error.
   */
  postCopilotNote(runId: string, content: string): Promise<boolean>;
  /**
   * The run's transcript snapshot, replaced whole (ROAD-124): the
   * daemon's committed turns as `acp.getHistory` serialises them, kept
   * opaque. The panel reads it when the daemon holds nothing.
   */
  saveTranscript(
    runId: string,
    turns: unknown[],
  ): Promise<{ turnCount: number }>;
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
  /**
   * W5b: the Jira credential, encoded for the backend's borrowed-credential
   * header (jira/jiraAuth.ts's encodeJiraCredentialHeader), or null when
   * nothing is connected. Read per request, never held: the wiring hands
   * in the reader so this module stays free of Electron. Sent only on the
   * requests that need it — a run's proposal on a Jira issue, a key
   * resolution — the way proposalApproval.ts sends it only on an approve.
   */
  jiraCredentialHeader?: () => string | null;
}

/** The header name the backend parses (waypoint-backend/src/lib/jira/credentialHeader.ts). */
export const JIRA_CREDENTIAL_HEADER = 'x-waypoint-jira-credential';

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

/** `ROAD-116`: a project key, a hyphen, a number — the one other thing that reaches a ticket URL. */
export const TICKET_IDENTIFIER = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
/**
 * A Jira issue key as the backend's provider accepts it — a project key
 * may carry an underscore, and is matched case-insensitively (people type
 * `eng-4`). Every key that reaches a resolve or ref URL passes this.
 */
export const JIRA_ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}-\d{1,9}$/;

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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: unknown,
    options: { withJiraCredential?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.withJiraCredential) {
      // No connected account simply omits the header; the backend treats
      // absent and malformed alike as "Jira is not connected".
      const credential = deps.jiraCredentialHeader?.() ?? null;
      if (credential) headers[JIRA_CREDENTIAL_HEADER] = credential;
    }
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
        headers,
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
    async claimPublish(id, headSha) {
      assertRunId(id);
      await request<unknown>('POST', `/agent-runs/${id}/publish-claim`, {
        ...(headSha ? { headSha } : {}),
      });
    },
    async listEvents(id, options = {}) {
      assertRunId(id);
      const params = new URLSearchParams({ limit: '500' });
      if (options.afterSeq !== undefined)
        params.set('afterSeq', String(options.afterSeq));
      return (
        await request<AgentRunEvent[]>(
          'GET',
          `/agent-runs/${id}/events?${params}`,
        )
      ).body;
    },
    async getTranscript(id) {
      assertRunId(id);
      try {
        return (
          await request<{ turns: unknown[]; turnCount: number }>(
            'GET',
            `/agent-runs/${id}/transcript`,
          )
        ).body;
      } catch (error) {
        if (error instanceof LedgerRequestError && error.status === 404)
          return null;
        throw error;
      }
    },
    async listPendingPrompts(id) {
      assertRunId(id);
      return (
        await request<PendingPrompt[]>(
          'GET',
          `/agent-runs/${id}/pending-prompts`,
        )
      ).body;
    },
    async createPendingPrompt(id, input) {
      assertRunId(id);
      return (
        await request<PendingPrompt>(
          'POST',
          `/agent-runs/${id}/pending-prompts`,
          input,
        )
      ).body;
    },
    async updatePendingPrompt(id, pendingId, patch) {
      assertRunId(id);
      assertRunId(pendingId);
      return (
        await request<PendingPrompt>(
          'PATCH',
          `/agent-runs/${id}/pending-prompts/${pendingId}`,
          patch,
        )
      ).body;
    },
    async reopenRun(id, reason) {
      assertRunId(id);
      return (
        await request<{ run: AgentRun; from: AgentRunStatus }>(
          'POST',
          `/agent-runs/${id}/reopen`,
          reason !== undefined ? { reason } : {},
        )
      ).body;
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
    async getTicketByIdentifier(identifier) {
      if (!TICKET_IDENTIFIER.test(identifier))
        throw new Error(`Not a ticket key: ${JSON.stringify(identifier)}`);
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
          }>('GET', `/tickets/by-identifier/${encodeURIComponent(identifier)}`)
        ).body;
        if (!t || typeof t !== 'object' || !t.id) return null;
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
      const { body } = await request<{ proposals?: LedgerProposal[] }>(
        'GET',
        `/tickets/${ticketId}/proposals`,
      );
      return Array.isArray(body?.proposals) ? body.proposals : [];
    },
    async createRunProposal(runId, input, options = {}) {
      assertRunId(runId);
      const created = (
        await request<{ id: string }>(
          'POST',
          `/agent-runs/${runId}/proposals`,
          input,
          { withJiraCredential: options.external === true },
        )
      ).body;
      return { id: created.id };
    },
    async getTicketRef(id) {
      assertRunId(id);
      if (!isTicketRef(id)) return null;
      try {
        const row = (
          await request<{
            id: string;
            provider: string;
            site?: string | null;
            externalId: string;
            identifier: string;
            title: string;
            url?: string | null;
          }>('GET', `/ticket-refs/${id}`)
        ).body;
        return {
          id: row.id,
          provider: row.provider,
          site: row.site ?? null,
          key: row.externalId,
          identifier: row.identifier,
          title: row.title,
          url: row.url ?? null,
        };
      } catch (error) {
        if (error instanceof LedgerRequestError && error.status === 404)
          return null;
        throw error;
      }
    },
    async rememberTicketRef(input) {
      if (!JIRA_ISSUE_KEY.test(input.key))
        throw new Error(`Not a Jira issue key: ${JSON.stringify(input.key)}`);
      const row = (
        await request<{
          id: string;
          provider: string;
          site?: string | null;
          externalId: string;
          identifier: string;
          title: string;
          url?: string | null;
        }>('POST', '/ticket-refs', {
          provider: 'jira',
          site: input.site,
          key: input.key,
          title: input.title,
        })
      ).body;
      return {
        id: row.id,
        provider: row.provider,
        site: row.site ?? null,
        key: row.externalId,
        identifier: row.identifier,
        title: row.title,
        url: row.url ?? null,
      };
    },
    async resolveTicket(identifier) {
      if (!JIRA_ISSUE_KEY.test(identifier))
        throw new Error(`Not a ticket key: ${JSON.stringify(identifier)}`);
      try {
        const t = (
          await request<ResolvedTicket>(
            'GET',
            `/tickets/resolve/${encodeURIComponent(identifier)}`,
            undefined,
            { withJiraCredential: true },
          )
        ).body;
        if (!t || typeof t !== 'object' || !t.id) return null;
        return {
          provider: t.provider === 'jira' ? 'jira' : 'native',
          id: t.id,
          identifier: t.identifier,
          title: t.title,
          projectId: t.projectId,
          url: t.url ?? null,
        };
      } catch (error) {
        if (error instanceof LedgerRequestError && error.status === 404)
          return null;
        throw error;
      }
    },
    async saveTranscript(runId, turns) {
      assertRunId(runId);
      const saved = (
        await request<{ turnCount: number }>(
          'PUT',
          `/agent-runs/${runId}/transcript`,
          { turns },
        )
      ).body;
      return { turnCount: saved.turnCount };
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
