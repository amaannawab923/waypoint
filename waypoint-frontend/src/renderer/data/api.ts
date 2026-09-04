// The one and only integration point between UI code and data. Every export
// here is an async function with the exact same name/signature it always
// had — only the implementation changed, from a localStorage-backed mock to
// real HTTP calls against waypoint-server (see /Users/amaannawab/waypoint-server).
// UI code must never talk to `http`/fetch directly; it only ever imports
// from this file.

import { http } from '@/data/httpClient';
import { CURRENT_USER_ID } from '@/data/currentUser';
import type { Probe } from '@/types/probe';
import type {
  Workspace,
  Member,
  MemberRole,
  Project,
  TicketState,
  Label,
  Workstream,
  Sprint,
  Ticket,
  Comment,
  ActivityEntry,
  Doc,
  SavedView,
  Request,
  RequestStatus,
  ScratchNote,
  NotificationItem,
  ProjectEstimateSystem,
  ProjectAutomations,
  Priority,
  TicketFilterQuery,
  WorkspaceExport,
  Webhook,
  WebhookEventType,
  Agent,
  AgentAssignment,
  AgentInstructionsFile,
  AgentAutonomy,
  AgentTrigger,
  ExecutionMethod,
  CopilotConversation,
  CopilotConversationSummary,
  CopilotMessage,
  ProposalView,
  ProposalStatus,
  ProposalKind,
} from '@/types/entities';

// Server-side `numeric` columns come back over JSON as strings (to avoid
// float precision loss) — Ticket.estimatePoints is `number | null` on the
// client, so this is the one field that needs normalizing after every fetch.
// Also strips `sortOrder`, a server-only field not in the Ticket type.
function normalizeTicket(raw: Ticket & { sortOrder?: string }): Ticket {
  const { sortOrder: _sortOrder, ...rest } = raw;
  return {
    ...rest,
    estimatePoints:
      rest.estimatePoints == null ? null : Number(rest.estimatePoints),
  };
}
function normalizeTickets(raw: (Ticket & { sortOrder?: string })[]): Ticket[] {
  return raw.map(normalizeTicket);
}
function normalizeTicketMaybe(
  raw: (Ticket & { sortOrder?: string }) | undefined,
): Ticket | undefined {
  return raw ? normalizeTicket(raw) : undefined;
}

// Wire encoding for GET /tickets?filter=<base64url> and its project-scoped
// sibling (docs/design/waypoint-revamp-architecture.md §4.6) — mirrors the
// backend's `Buffer.from(json, 'utf8').toString('base64url')` convention
// (waypoint-backend/src/services/proposals.service.ts's list cursors) as
// closely as the renderer's Buffer-less environment allows: standard
// base64 via btoa (the encodeURIComponent/unescape pair makes it UTF-8
// safe for non-ASCII filter text), then remapped to the URL-safe alphabet
// with padding stripped.
function encodeTicketFilterParam(filter: TicketFilterQuery): string {
  const json = JSON.stringify(filter);
  const standard = btoa(unescape(encodeURIComponent(json)));
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Session / workspace
// ---------------------------------------------------------------------------

export async function getCurrentUser(): Promise<Member> {
  return http.get<Member>('/me');
}

export async function getWorkspace(): Promise<Workspace> {
  return http.get<Workspace>('/workspace');
}

export async function updateWorkspace(
  patch: Partial<Workspace>,
): Promise<Workspace> {
  return http.patch<Workspace>('/workspace', patch);
}

export async function listMembers(): Promise<Member[]> {
  return http.get<Member[]>('/members');
}

export async function inviteMember(input: {
  email: string;
  role: Member['role'];
}): Promise<Member> {
  return http.post<Member>('/members', input);
}

// New — the original mock's Profile Settings "Save changes" button never
// actually persisted anything (see profile-settings/Profile.tsx), which
// looked like a save but silently discarded every edit. This is the real
// endpoint it's now wired to.
export async function updateCurrentUser(
  patch: Partial<Pick<Member, 'fullName' | 'displayName' | 'email' | 'firstDayOfWeek' | 'notificationPrefs'>>,
): Promise<Member> {
  return http.patch<Member>('/me', patch);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export async function listExports(): Promise<WorkspaceExport[]> {
  return http.get<WorkspaceExport[]>('/exports');
}

export async function createExport(input: {
  scopeLabel: string;
  format: string;
}): Promise<WorkspaceExport> {
  return http.post<WorkspaceExport>('/exports', input);
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function listWebhooks(): Promise<Webhook[]> {
  return http.get<Webhook[]>('/webhooks');
}

export async function createWebhook(input: {
  url: string;
  eventTypes: WebhookEventType[];
}): Promise<Webhook> {
  return http.post<Webhook>('/webhooks', input);
}

export async function deleteWebhook(id: string): Promise<void> {
  return http.del<void>(`/webhooks/${id}`);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export async function listAgents(): Promise<Agent[]> {
  return http.get<Agent[]>('/agents');
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  return http.get<Agent | undefined>(`/agents/${id}`, {
    notFoundAsUndefined: true,
  });
}

export interface CreateAgentInput {
  name: string;
  avatarColor: string;
  instructionsFile: AgentInstructionsFile;
  scopeAllProjects: boolean;
  scopeProjectIds?: string[];
  executionMethod: ExecutionMethod;
  model: string;
  autonomy: AgentAutonomy;
  triggers?: AgentTrigger[];
  templateId?: string;
}

export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  return http.post<Agent>('/agents', input);
}

export async function updateAgent(
  id: string,
  patch: Partial<
    Pick<
      Agent,
      | 'name'
      | 'avatarColor'
      | 'instructionsFile'
      | 'scopeAllProjects'
      | 'scopeProjectIds'
      | 'executionMethod'
      | 'model'
      | 'autonomy'
      | 'triggers'
      | 'isActive'
    >
  >,
): Promise<Agent> {
  return http.patch<Agent>(`/agents/${id}`, patch);
}

export async function deleteAgent(id: string): Promise<void> {
  return http.del<void>(`/agents/${id}`);
}

// Resolves whether the real Claude Code CLI is installed on this machine —
// via the Electron main process's `copilot:detect` handler
// (src/main/copilot/copilotDetect.ts), which actually runs `claude
// --version` with the augmented PATH. This used to unconditionally resolve
// `{status:'connected', version:'2.4.1'}` after a fake delay, regardless of
// the real machine state — see
// docs/design/waypoint-revamp-architecture.md §1.4 and work breakdown
// W1.2. Deliberately NOT an HTTP call: this is a local-machine check that
// belongs in the Electron main process, not waypoint-server.
//
// Returns a `Probe<T>` rather than a bare status so a "connected" claim can
// only ever be constructed from what was actually read — see
// types/probe.ts and components/ui/StatusBadge.tsx.
export async function detectLocalClaudeCode(): Promise<
  Probe<{ version: string; path: string }>
> {
  const via = 'claude --version';
  try {
    const result = await window.electron.copilot.detect();
    const observedAt = new Date().toISOString();
    if (result.ok) {
      return {
        state: 'present',
        value: { version: result.version, path: result.path },
        observedAt,
        via,
      };
    }
    if (result.reason === 'not-found') {
      return { state: 'absent', reason: result.message, observedAt, via };
    }
    return { state: 'error', reason: result.message, observedAt, via };
  } catch (err) {
    return {
      state: 'error',
      reason:
        err instanceof Error ? err.message : "Couldn't check for Claude Code.",
      observedAt: new Date().toISOString(),
      via,
    };
  }
}

export async function listAgentAssignments(): Promise<AgentAssignment[]> {
  return http.get<AgentAssignment[]>('/agent-assignments');
}

// Used right after createTicket when a brand-new ticket is born pre-assigned
// to one or more agents (e.g. from the New Ticket modal) — createTicket
// itself only knows about assigneeIds, not the agent-run bookkeeping.
export async function ensureAgentAssignments(
  ticketId: string,
  agentIds: string[],
): Promise<void> {
  return http.post<void>(`/tickets/${ticketId}/agent-assignments`, {
    agentIds,
  });
}

// Assigns/unassigns an agent the same way toggleTicketAssignee handles a
// human — reuses the same assigneeIds array (agent and member ids are both
// opaque strings) but also maintains the agent's own AgentAssignment run
// record, which a human assignee doesn't need. Unassigning through this path
// leaves the AgentAssignment row in place (with its history); use
// takeBackOverFromAgent instead when the removal should read as a hand-off.
export async function toggleTicketAgent(
  ticketId: string,
  agentId: string,
): Promise<Ticket> {
  const item = await http.post<Ticket & { sortOrder?: string }>(
    `/tickets/${ticketId}/agents/${agentId}/toggle`,
  );
  return normalizeTicket(item);
}

// Removes the agent from assigneeIds (same mechanics as a human unassign),
// closes out its run record, and posts a system-style comment from the
// current user — so a hand-off reads the same as everything else in the
// Activity/Comments feed instead of the agent silently vanishing.
export async function takeBackOverFromAgent(
  ticketId: string,
  agentId: string,
): Promise<Ticket> {
  const item = await http.post<Ticket & { sortOrder?: string }>(
    `/tickets/${ticketId}/agents/${agentId}/take-back`,
  );
  return normalizeTicket(item);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  return http.get<Project[]>('/projects');
}

export async function listArchivedProjects(): Promise<Project[]> {
  return http.get<Project[]>('/projects/archived');
}

export async function getProject(id: string): Promise<Project | undefined> {
  return http.get<Project | undefined>(`/projects/${id}`, {
    notFoundAsUndefined: true,
  });
}

export interface CreateProjectInput {
  name: string;
  identifier: string;
  description?: string;
  icon?: string;
  visibility?: Project['visibility'];
  leadId?: string | null;
}

export async function createProject(
  input: CreateProjectInput,
): Promise<Project> {
  return http.post<Project>('/projects', input);
}

export async function updateProject(
  id: string,
  patch: Partial<Project>,
): Promise<Project> {
  return http.patch<Project>(`/projects/${id}`, patch);
}

export async function addProjectMember(
  projectId: string,
  memberId: string,
  role?: MemberRole,
): Promise<Project> {
  return http.post<Project>(`/projects/${projectId}/members`, {
    memberId,
    role,
  });
}

export async function removeProjectMember(
  projectId: string,
  memberId: string,
): Promise<Project> {
  return http.del<Project>(`/projects/${projectId}/members/${memberId}`);
}

export async function updateProjectEstimate(
  id: string,
  estimate: ProjectEstimateSystem | null,
): Promise<Project> {
  return http.put<Project>(`/projects/${id}/estimate`, estimate);
}

export async function getProjectAutomations(
  projectId: string,
): Promise<ProjectAutomations> {
  return http.get<ProjectAutomations>(`/projects/${projectId}/automations`);
}

export async function updateProjectAutomations(
  id: string,
  patch: Partial<ProjectAutomations>,
): Promise<Project> {
  return http.patch<Project>(`/projects/${id}/automations`, patch);
}

export async function archiveProject(id: string): Promise<void> {
  return http.post<void>(`/projects/${id}/archive`);
}

export async function deleteProject(id: string): Promise<void> {
  return http.del<void>(`/projects/${id}`);
}

// ---------------------------------------------------------------------------
// States & labels
// ---------------------------------------------------------------------------

export async function listStates(projectId: string): Promise<TicketState[]> {
  return http.get<TicketState[]>(`/states?projectId=${projectId}`);
}

export async function createState(
  projectId: string,
  input: Pick<TicketState, 'name' | 'group' | 'color'>,
): Promise<TicketState> {
  return http.post<TicketState>(`/projects/${projectId}/states`, input);
}

export async function updateState(
  id: string,
  patch: Partial<Pick<TicketState, 'name' | 'group' | 'color'>>,
): Promise<TicketState> {
  return http.patch<TicketState>(`/states/${id}`, patch);
}

export async function countTicketsInState(stateId: string): Promise<number> {
  const { count } = await http.get<{ count: number }>(
    `/states/${stateId}/ticket-count`,
  );
  return count;
}

export async function deleteState(id: string): Promise<void> {
  return http.del<void>(`/states/${id}`);
}

export async function listLabels(projectId: string): Promise<Label[]> {
  return http.get<Label[]>(`/labels?projectId=${projectId}`);
}

export async function createLabel(
  projectId: string,
  input: Pick<Label, 'name' | 'color'>,
): Promise<Label> {
  return http.post<Label>(`/projects/${projectId}/labels`, input);
}

export async function updateLabel(
  id: string,
  patch: Partial<Pick<Label, 'name' | 'color'>>,
): Promise<Label> {
  return http.patch<Label>(`/labels/${id}`, patch);
}

export async function deleteLabel(id: string): Promise<void> {
  return http.del<void>(`/labels/${id}`);
}

// ---------------------------------------------------------------------------
// Workstreams & sprints
// ---------------------------------------------------------------------------

export async function listWorkstreams(
  projectId: string,
): Promise<Workstream[]> {
  return http.get<Workstream[]>(`/projects/${projectId}/workstreams`);
}

export async function listAllWorkstreams(): Promise<Workstream[]> {
  return http.get<Workstream[]>('/workstreams');
}

export async function createWorkstream(
  projectId: string,
  input: Partial<Workstream> & { name: string },
): Promise<Workstream> {
  return http.post<Workstream>(`/projects/${projectId}/workstreams`, input);
}

export async function updateWorkstream(
  id: string,
  patch: Partial<Workstream>,
): Promise<Workstream> {
  return http.patch<Workstream>(`/workstreams/${id}`, patch);
}

export async function listSprints(projectId: string): Promise<Sprint[]> {
  return http.get<Sprint[]>(`/projects/${projectId}/sprints`);
}

export async function listAllSprints(): Promise<Sprint[]> {
  return http.get<Sprint[]>('/sprints');
}

export async function createSprint(
  projectId: string,
  input: Pick<Sprint, 'name' | 'description' | 'startDate' | 'endDate'> &
    Partial<Pick<Sprint, 'leadId' | 'memberIds'>>,
): Promise<Sprint> {
  return http.post<Sprint>(`/projects/${projectId}/sprints`, input);
}

export async function updateSprint(
  id: string,
  patch: Partial<
    Pick<
      Sprint,
      'name' | 'description' | 'startDate' | 'endDate' | 'leadId' | 'memberIds'
    >
  >,
): Promise<Sprint> {
  return http.patch<Sprint>(`/sprints/${id}`, patch);
}

export async function deleteSprint(id: string): Promise<void> {
  return http.del<void>(`/sprints/${id}`);
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export async function listTickets(
  projectId: string,
  filter?: TicketFilterQuery,
): Promise<Ticket[]> {
  const query = filter ? `?filter=${encodeTicketFilterParam(filter)}` : '';
  return normalizeTickets(
    await http.get<(Ticket & { sortOrder?: string })[]>(
      `/projects/${projectId}/tickets${query}`,
    ),
  );
}

export async function listAllTickets(
  filter?: TicketFilterQuery,
): Promise<Ticket[]> {
  const query = filter ? `?filter=${encodeTicketFilterParam(filter)}` : '';
  return normalizeTickets(
    await http.get<(Ticket & { sortOrder?: string })[]>(`/tickets${query}`),
  );
}

export async function listDraftTickets(): Promise<Ticket[]> {
  return normalizeTickets(
    await http.get<(Ticket & { sortOrder?: string })[]>('/tickets/drafts'),
  );
}

export async function getTicket(id: string): Promise<Ticket | undefined> {
  return normalizeTicketMaybe(
    await http.get<(Ticket & { sortOrder?: string }) | undefined>(
      `/tickets/${id}`,
      { notFoundAsUndefined: true },
    ),
  );
}

export async function getTicketByIdentifier(
  identifier: string,
): Promise<Ticket | undefined> {
  return normalizeTicketMaybe(
    await http.get<(Ticket & { sortOrder?: string }) | undefined>(
      `/tickets/by-identifier/${identifier}`,
      {
        notFoundAsUndefined: true,
      },
    ),
  );
}

export interface CreateTicketInput {
  projectId: string;
  title: string;
  description?: string;
  stateId: string;
  priority?: Ticket['priority'];
  assigneeIds?: string[];
  labelIds?: string[];
  workstreamId?: string | null;
  sprintId?: string | null;
  parentId?: string | null;
  isDraft?: boolean;
}

export async function createTicket(input: CreateTicketInput): Promise<Ticket> {
  return normalizeTicket(
    await http.post<Ticket & { sortOrder?: string }>('/tickets', input),
  );
}

export async function updateTicket(
  id: string,
  patch: Partial<Ticket>,
): Promise<Ticket> {
  return normalizeTicket(
    await http.patch<Ticket & { sortOrder?: string }>(`/tickets/${id}`, patch),
  );
}

// Toggles `memberId` in the item's assigneeIds — the server reads the
// current persisted value itself, same race-avoidance as before.
export async function toggleTicketAssignee(
  id: string,
  memberId: string,
): Promise<Ticket> {
  return normalizeTicket(
    await http.post<Ticket & { sortOrder?: string }>(
      `/tickets/${id}/assignees/${memberId}/toggle`,
    ),
  );
}

export async function toggleTicketLabel(
  id: string,
  labelId: string,
): Promise<Ticket> {
  return normalizeTicket(
    await http.post<Ticket & { sortOrder?: string }>(
      `/tickets/${id}/labels/${labelId}/toggle`,
    ),
  );
}

// Repositions `id` directly before/after `targetId` — list/board views
// render in the server's `sortOrder`, so this is what makes manual
// drag-to-reorder stick. If the target is in a different state, adopts that
// state too (matching dropping a card into a column at a specific position).
export async function reorderTicket(
  id: string,
  targetId: string,
  position: 'before' | 'after',
): Promise<Ticket> {
  return normalizeTicket(
    await http.post<Ticket & { sortOrder?: string }>(`/tickets/${id}/reorder`, {
      targetId,
      position,
    }),
  );
}

export async function deleteTicket(id: string): Promise<void> {
  return http.del<void>(`/tickets/${id}`);
}

export async function listSubItems(parentId: string): Promise<Ticket[]> {
  return normalizeTickets(
    await http.get<(Ticket & { sortOrder?: string })[]>(
      `/tickets/${parentId}/sub-items`,
    ),
  );
}

export async function addTicketLink(
  ticketId: string,
  input: { url: string; label: string },
): Promise<Ticket> {
  return normalizeTicket(
    await http.post<Ticket & { sortOrder?: string }>(
      `/tickets/${ticketId}/links`,
      input,
    ),
  );
}

export async function removeTicketLink(
  ticketId: string,
  linkId: string,
): Promise<Ticket> {
  return normalizeTicket(
    await http.del<Ticket & { sortOrder?: string }>(
      `/tickets/${ticketId}/links/${linkId}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Comments & activity
// ---------------------------------------------------------------------------

export async function listComments(ticketId: string): Promise<Comment[]> {
  return http.get<Comment[]>(`/tickets/${ticketId}/comments`);
}

export async function addComment(
  ticketId: string,
  bodyHtml: string,
): Promise<Comment> {
  return http.post<Comment>(`/tickets/${ticketId}/comments`, { bodyHtml });
}

export async function listActivity(ticketId: string): Promise<ActivityEntry[]> {
  return http.get<ActivityEntry[]>(`/tickets/${ticketId}/activity`);
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

export async function listDocs(projectId: string): Promise<Doc[]> {
  return http.get<Doc[]>(`/projects/${projectId}/docs`);
}

export async function listAllDocs(): Promise<Doc[]> {
  return http.get<Doc[]>('/docs');
}

export async function getDoc(id: string): Promise<Doc | undefined> {
  return http.get<Doc | undefined>(`/docs/${id}`, {
    notFoundAsUndefined: true,
  });
}

export async function createDoc(
  projectId: string,
  title = 'Untitled',
  parentDocId: string | null = null,
): Promise<Doc> {
  return http.post<Doc>(`/projects/${projectId}/docs`, {
    title,
    parentDocId,
  });
}

export async function updateDoc(id: string, patch: Partial<Doc>): Promise<Doc> {
  return http.patch<Doc>(`/docs/${id}`, patch);
}

export async function deleteDoc(id: string): Promise<void> {
  return http.del<void>(`/docs/${id}`);
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export async function listViews(projectId: string): Promise<SavedView[]> {
  return http.get<SavedView[]>(`/projects/${projectId}/views`);
}

export async function createView(
  projectId: string,
  name: string,
  filters: TicketFilterQuery,
): Promise<SavedView> {
  return http.post<SavedView>(`/projects/${projectId}/views`, {
    name,
    filters,
  });
}

export async function updateView(
  id: string,
  patch: Partial<
    Pick<SavedView, 'name' | 'filters' | 'visibility' | 'isFavorite'>
  >,
): Promise<SavedView> {
  return http.patch<SavedView>(`/views/${id}`, patch);
}

export async function deleteView(id: string): Promise<void> {
  return http.del<void>(`/views/${id}`);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export async function listRequests(projectId: string): Promise<Request[]> {
  return http.get<Request[]>(`/projects/${projectId}/requests`);
}

export interface CreateRequestInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: Priority;
  sourceName: string;
  sourceEmail: string;
}

export async function createRequest(
  input: CreateRequestInput,
): Promise<Request> {
  return http.post<Request>('/requests', input);
}

export async function updateRequestStatus(
  id: string,
  status: RequestStatus,
): Promise<Request> {
  return http.patch<Request>(`/requests/${id}/status`, { status });
}

export async function convertRequestToTicket(
  id: string,
  stateId: string,
  overrides?: Partial<Pick<Ticket, 'title' | 'description' | 'priority'>>,
): Promise<Ticket> {
  return normalizeTicket(
    await http.post<Ticket & { sortOrder?: string }>(
      `/requests/${id}/convert`,
      { stateId, ...overrides },
    ),
  );
}

// ---------------------------------------------------------------------------
// Scratch notes & notifications
// ---------------------------------------------------------------------------

export async function listScratchNotes(): Promise<ScratchNote[]> {
  return http.get<ScratchNote[]>('/scratch-notes');
}

export async function createScratchNote(
  title: string,
  body: string,
): Promise<ScratchNote> {
  return http.post<ScratchNote>('/scratch-notes', { title, body });
}

export async function deleteScratchNote(id: string): Promise<void> {
  return http.del<void>(`/scratch-notes/${id}`);
}

export async function listNotifications(): Promise<NotificationItem[]> {
  return http.get<NotificationItem[]>('/notifications');
}

export async function markNotificationRead(id: string): Promise<void> {
  return http.post<void>(`/notifications/${id}/read`);
}

// ---------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------

// Multiple conversations per member (issue #11) — see
// lib/useCopilotConversations.ts for the hook that fetches these and merges
// in local-only pin/order metadata for the session-list UI.
export async function listCopilotConversations(): Promise<
  CopilotConversationSummary[]
> {
  return http.get<CopilotConversationSummary[]>('/copilot/conversations');
}

export async function createCopilotConversation(): Promise<CopilotConversationSummary> {
  return http.post<CopilotConversationSummary>('/copilot/conversations');
}

export async function getCopilotConversation(
  id: string,
): Promise<CopilotConversation> {
  return http.get<CopilotConversation>(`/copilot/conversations/${id}`);
}

export async function renameCopilotConversation(
  id: string,
  title: string,
): Promise<CopilotConversationSummary> {
  return http.patch<CopilotConversationSummary>(
    `/copilot/conversations/${id}`,
    { title },
  );
}

export async function deleteCopilotConversation(id: string): Promise<void> {
  return http.del<void>(`/copilot/conversations/${id}`);
}

// Split from a single sendCopilotMessage (issue #6) into two calls (issue
// #7): the assistant's reply now comes from a real, streamed Claude Code CLI
// run in Electron's main process, not something the backend can compute and
// return within one request — see CopilotPanel.tsx's handleSend.
export async function postCopilotUserMessage(
  conversationId: string,
  content: string,
): Promise<CopilotMessage> {
  return http.post<CopilotMessage>(
    `/copilot/conversations/${conversationId}/messages`,
    { content },
  );
}

export async function postCopilotAssistantMessage(
  conversationId: string,
  content: string,
  claudeSessionId: string | null,
): Promise<CopilotMessage> {
  return http.post<CopilotMessage>(
    `/copilot/conversations/${conversationId}/messages/assistant`,
    {
      content,
      claudeSessionId,
    },
  );
}

// Copilot V2 write proposals (issue #10) — see lib/useCopilotProposals.ts
// for the hook that owns this data, and CopilotProposalCard.tsx for the
// card each row renders as. Approve/reject return the finalized row (200
// even for stale/expired outcomes — the status field IS the result), so
// callers patch their local list from the response instead of refetching.
export async function listCopilotProposals(
  conversationId: string,
): Promise<ProposalView[]> {
  return http.get<ProposalView[]>(
    `/copilot/conversations/${conversationId}/proposals`,
  );
}

export async function approveCopilotProposal(
  id: string,
): Promise<ProposalView> {
  return http.post<ProposalView>(`/copilot/proposals/${id}/approve`, {});
}

export async function rejectCopilotProposal(id: string): Promise<ProposalView> {
  return http.post<ProposalView>(`/copilot/proposals/${id}/reject`, {});
}

export async function rejectAllCopilotProposals(
  conversationId: string,
): Promise<{ rejected: number }> {
  return http.post<{ rejected: number }>(
    `/copilot/conversations/${conversationId}/proposals/reject-all`,
    {},
  );
}

export async function markCopilotProposalsNotified(
  conversationId: string,
  ids: string[],
): Promise<{ notified: number }> {
  return http.post<{ notified: number }>(
    `/copilot/conversations/${conversationId}/proposals/notified`,
    { ids },
  );
}

// W4.5 (architecture §4.2/§4.4, waypoint-product-strategy.md decision 10) —
// the Analytics tile's data source, backed by the workspace-scoped review
// queue's aggregate surface (bare /proposals/..., NOT /copilot/proposals/...
// above — see reviewQueue.routes.ts). averagePerActiveDay is null, not 0,
// when there is no data yet — the honest "not enough data" state.
export interface ApprovedPerActiveDayStats {
  approvedCount: number;
  activeDays: number;
  averagePerActiveDay: number | null;
}

export async function getApprovedPerActiveDayStats(): Promise<ApprovedPerActiveDayStats> {
  return http.get<ApprovedPerActiveDayStats>('/proposals/stats/approved-per-day');
}

// The workspace-scoped review-queue aggregate (architecture §4.4,
// reviewQueue.routes.ts) — NOT yet consumed anywhere in this unit (W4.1
// only needs the two conversation-scoped POSTs above). Added now, ahead of
// need, so W4.3's Review screen doesn't have to touch this file again: it
// reuses the same single-row approve/reject state machine as the endpoints
// above, just batched, id-per-row rather than one transaction (a stale id
// resolves on its own; the rest of the batch still runs).
export interface BulkProposalResult {
  id: string;
  status: ProposalStatus | 'not_found';
  statusReason: string | null;
}

export async function bulkApproveProposals(
  ids: string[],
): Promise<BulkProposalResult[]> {
  const { results } = await http.post<{ results: BulkProposalResult[] }>(
    '/proposals/bulk-approve',
    { ids },
  );
  return results;
}

export async function bulkRejectProposals(
  ids: string[],
): Promise<BulkProposalResult[]> {
  const { results } = await http.post<{ results: BulkProposalResult[] }>(
    '/proposals/bulk-reject',
    { ids },
  );
  return results;
}

// W4.4 (architecture §4.4) — ticket-detail's and the Requests page's inline
// "pending proposals" sections. Both endpoints live on reviewQueue.routes.ts
// (bare /tickets/:id/proposals, /requests/:id/proposals — NOT the
// conversation-scoped /copilot/... paths above) and return the same
// `{ proposals: ProposalView[] }` envelope; callers feed the result straight
// into lib/proposalStore.ts's upsertProposals, same as listCopilotProposals.
export async function listTicketProposals(
  ticketId: string,
  status?: ProposalStatus,
): Promise<ProposalView[]> {
  const query = status ? `?status=${status}` : '';
  const { proposals } = await http.get<{ proposals: ProposalView[] }>(
    `/tickets/${ticketId}/proposals${query}`,
  );
  return proposals;
}

export async function listRequestProposals(
  requestId: string,
  status?: ProposalStatus,
): Promise<ProposalView[]> {
  const query = status ? `?status=${status}` : '';
  const { proposals } = await http.get<{ proposals: ProposalView[] }>(
    `/requests/${requestId}/proposals${query}`,
  );
  return proposals;
}

// W4.3 — the Review screen's own data source: segments, agent/project/kind
// filters, and keyset pagination (architecture §4.4). Counts are
// workspace-wide and unfiltered by the caller's filters (they back the
// segment tabs themselves, which stay stable while a filter narrows what's
// listed inside the selected tab — see reviewQueue.routes.ts's own comment).
export type ReviewQueueSegment = 'proposed' | 'blocked' | 'recent';

export interface ReviewQueueCounts {
  proposed: number;
  blocked: number;
  recent: number;
}

export interface ReviewQueueParams {
  status: ReviewQueueSegment;
  agentId?: string;
  projectId?: string;
  kind?: ProposalKind;
  limit?: number;
  cursor?: string;
}

export interface ReviewQueueResult {
  proposals: ProposalView[];
  counts: ReviewQueueCounts;
  nextCursor: string | null;
}

export async function listReviewQueue(
  params: ReviewQueueParams,
): Promise<ReviewQueueResult> {
  const search = new URLSearchParams({ status: params.status });
  if (params.agentId) search.set('agentId', params.agentId);
  if (params.projectId) search.set('projectId', params.projectId);
  if (params.kind) search.set('kind', params.kind);
  if (params.limit != null) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  return http.get<ReviewQueueResult>(`/proposals?${search.toString()}`);
}

export async function getProposalCounts(): Promise<ReviewQueueCounts> {
  return http.get<ReviewQueueCounts>('/proposals/counts');
}

// W4.3 (architecture §4.4/§4.5) — the review screen's health-strip data
// source. approvalRate/medianDecisionMs are null (not 0/NaN), the same
// "honest null" shape as ApprovedPerActiveDayStats.averagePerActiveDay
// above, until decisionCount reaches the accept criterion's floor of 10.
export interface ReviewHealthStats {
  decisionCount: number;
  approvalRate: number | null;
  medianDecisionMs: number | null;
}

export async function getReviewHealthStats(): Promise<ReviewHealthStats> {
  return http.get<ReviewHealthStats>('/proposals/stats/health');
}

// ---------------------------------------------------------------------------
// Dev/demo utility
// ---------------------------------------------------------------------------

export async function resetAllData(): Promise<void> {
  return http.post<void>('/dev/reset');
}

export { CURRENT_USER_ID };
