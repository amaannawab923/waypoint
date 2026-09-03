// The one and only integration point between UI code and data. Every export
// here is an async function with the exact same name/signature it always
// had — only the implementation changed, from a localStorage-backed mock to
// real HTTP calls against waypoint-server (see /Users/amaannawab/waypoint-server).
// UI code must never talk to `http`/fetch directly; it only ever imports
// from this file.

import { http } from '@/mock/httpClient';
import { CURRENT_USER_ID } from '@/mock/currentUser';
import type { Probe } from '@/types/probe';
import type {
  Workspace,
  Member,
  MemberRole,
  Project,
  WorkItemState,
  Label,
  WorkModule,
  Cycle,
  WorkItem,
  Comment,
  ActivityEntry,
  Page,
  SavedView,
  IntakeRequest,
  IntakeStatus,
  Sticky,
  NotificationItem,
  ProjectFeatures,
  ProjectEstimateSystem,
  ProjectAutomations,
  Priority,
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
  CopilotProposal,
} from '@/types/entities';

// Server-side `numeric` columns come back over JSON as strings (to avoid
// float precision loss) — WorkItem.estimatePoints is `number | null` on the
// client, so this is the one field that needs normalizing after every fetch.
// Also strips `sortOrder`, a server-only field not in the WorkItem type.
function normalizeWorkItem(raw: WorkItem & { sortOrder?: string }): WorkItem {
  const { sortOrder: _sortOrder, ...rest } = raw;
  return {
    ...rest,
    estimatePoints:
      rest.estimatePoints == null ? null : Number(rest.estimatePoints),
  };
}
function normalizeWorkItems(
  raw: (WorkItem & { sortOrder?: string })[],
): WorkItem[] {
  return raw.map(normalizeWorkItem);
}
function normalizeWorkItemMaybe(
  raw: (WorkItem & { sortOrder?: string }) | undefined,
): WorkItem | undefined {
  return raw ? normalizeWorkItem(raw) : undefined;
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
  patch: Partial<Pick<Member, 'fullName' | 'displayName' | 'email'>>,
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

// Used right after createWorkItem when a brand-new ticket is born pre-assigned
// to one or more agents (e.g. from the New Work Item modal) — createWorkItem
// itself only knows about assigneeIds, not the agent-run bookkeeping.
export async function ensureAgentAssignments(
  workItemId: string,
  agentIds: string[],
): Promise<void> {
  return http.post<void>(`/work-items/${workItemId}/agent-assignments`, {
    agentIds,
  });
}

// Assigns/unassigns an agent the same way toggleWorkItemAssignee handles a
// human — reuses the same assigneeIds array (agent and member ids are both
// opaque strings) but also maintains the agent's own AgentAssignment run
// record, which a human assignee doesn't need. Unassigning through this path
// leaves the AgentAssignment row in place (with its history); use
// takeBackOverFromAgent instead when the removal should read as a hand-off.
export async function toggleWorkItemAgent(
  workItemId: string,
  agentId: string,
): Promise<WorkItem> {
  const item = await http.post<WorkItem & { sortOrder?: string }>(
    `/work-items/${workItemId}/agents/${agentId}/toggle`,
  );
  return normalizeWorkItem(item);
}

// Removes the agent from assigneeIds (same mechanics as a human unassign),
// closes out its run record, and posts a system-style comment from the
// current user — so a hand-off reads the same as everything else in the
// Activity/Comments feed instead of the agent silently vanishing.
export async function takeBackOverFromAgent(
  workItemId: string,
  agentId: string,
): Promise<WorkItem> {
  const item = await http.post<WorkItem & { sortOrder?: string }>(
    `/work-items/${workItemId}/agents/${agentId}/take-back`,
  );
  return normalizeWorkItem(item);
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
  network?: Project['network'];
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

export async function updateProjectFeatures(
  id: string,
  patch: Partial<ProjectFeatures>,
): Promise<Project> {
  return http.patch<Project>(`/projects/${id}/features`, patch);
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

export async function listStates(projectId: string): Promise<WorkItemState[]> {
  return http.get<WorkItemState[]>(`/states?projectId=${projectId}`);
}

export async function createState(
  projectId: string,
  input: Pick<WorkItemState, 'name' | 'group' | 'color'>,
): Promise<WorkItemState> {
  return http.post<WorkItemState>(`/projects/${projectId}/states`, input);
}

export async function updateState(
  id: string,
  patch: Partial<Pick<WorkItemState, 'name' | 'group' | 'color'>>,
): Promise<WorkItemState> {
  return http.patch<WorkItemState>(`/states/${id}`, patch);
}

export async function countWorkItemsInState(stateId: string): Promise<number> {
  const { count } = await http.get<{ count: number }>(
    `/states/${stateId}/work-item-count`,
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
// Modules & cycles
// ---------------------------------------------------------------------------

export async function listModules(projectId: string): Promise<WorkModule[]> {
  return http.get<WorkModule[]>(`/projects/${projectId}/modules`);
}

export async function listAllModules(): Promise<WorkModule[]> {
  return http.get<WorkModule[]>('/modules');
}

export async function createModule(
  projectId: string,
  input: Partial<WorkModule> & { name: string },
): Promise<WorkModule> {
  return http.post<WorkModule>(`/projects/${projectId}/modules`, input);
}

export async function updateModule(
  id: string,
  patch: Partial<WorkModule>,
): Promise<WorkModule> {
  return http.patch<WorkModule>(`/modules/${id}`, patch);
}

export async function listCycles(projectId: string): Promise<Cycle[]> {
  return http.get<Cycle[]>(`/projects/${projectId}/cycles`);
}

export async function listAllCycles(): Promise<Cycle[]> {
  return http.get<Cycle[]>('/cycles');
}

export async function createCycle(
  projectId: string,
  input: Pick<Cycle, 'name' | 'description' | 'startDate' | 'endDate'> &
    Partial<Pick<Cycle, 'leadId' | 'memberIds'>>,
): Promise<Cycle> {
  return http.post<Cycle>(`/projects/${projectId}/cycles`, input);
}

export async function updateCycle(
  id: string,
  patch: Partial<
    Pick<
      Cycle,
      'name' | 'description' | 'startDate' | 'endDate' | 'leadId' | 'memberIds'
    >
  >,
): Promise<Cycle> {
  return http.patch<Cycle>(`/cycles/${id}`, patch);
}

export async function deleteCycle(id: string): Promise<void> {
  return http.del<void>(`/cycles/${id}`);
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

export async function listWorkItems(projectId: string): Promise<WorkItem[]> {
  return normalizeWorkItems(
    await http.get<(WorkItem & { sortOrder?: string })[]>(
      `/projects/${projectId}/work-items`,
    ),
  );
}

export async function listAllWorkItems(): Promise<WorkItem[]> {
  return normalizeWorkItems(
    await http.get<(WorkItem & { sortOrder?: string })[]>('/work-items'),
  );
}

export async function listDraftWorkItems(): Promise<WorkItem[]> {
  return normalizeWorkItems(
    await http.get<(WorkItem & { sortOrder?: string })[]>('/work-items/drafts'),
  );
}

export async function getWorkItem(id: string): Promise<WorkItem | undefined> {
  return normalizeWorkItemMaybe(
    await http.get<(WorkItem & { sortOrder?: string }) | undefined>(
      `/work-items/${id}`,
      { notFoundAsUndefined: true },
    ),
  );
}

export async function getWorkItemByIdentifier(
  identifier: string,
): Promise<WorkItem | undefined> {
  return normalizeWorkItemMaybe(
    await http.get<(WorkItem & { sortOrder?: string }) | undefined>(
      `/work-items/by-identifier/${identifier}`,
      {
        notFoundAsUndefined: true,
      },
    ),
  );
}

export interface CreateWorkItemInput {
  projectId: string;
  title: string;
  description?: string;
  stateId: string;
  priority?: WorkItem['priority'];
  assigneeIds?: string[];
  labelIds?: string[];
  moduleId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  isDraft?: boolean;
}

export async function createWorkItem(
  input: CreateWorkItemInput,
): Promise<WorkItem> {
  return normalizeWorkItem(
    await http.post<WorkItem & { sortOrder?: string }>('/work-items', input),
  );
}

export async function updateWorkItem(
  id: string,
  patch: Partial<WorkItem>,
): Promise<WorkItem> {
  return normalizeWorkItem(
    await http.patch<WorkItem & { sortOrder?: string }>(
      `/work-items/${id}`,
      patch,
    ),
  );
}

// Toggles `memberId` in the item's assigneeIds — the server reads the
// current persisted value itself, same race-avoidance as before.
export async function toggleWorkItemAssignee(
  id: string,
  memberId: string,
): Promise<WorkItem> {
  return normalizeWorkItem(
    await http.post<WorkItem & { sortOrder?: string }>(
      `/work-items/${id}/assignees/${memberId}/toggle`,
    ),
  );
}

export async function toggleWorkItemLabel(
  id: string,
  labelId: string,
): Promise<WorkItem> {
  return normalizeWorkItem(
    await http.post<WorkItem & { sortOrder?: string }>(
      `/work-items/${id}/labels/${labelId}/toggle`,
    ),
  );
}

// Repositions `id` directly before/after `targetId` — list/board views
// render in the server's `sortOrder`, so this is what makes manual
// drag-to-reorder stick. If the target is in a different state, adopts that
// state too (matching dropping a card into a column at a specific position).
export async function reorderWorkItem(
  id: string,
  targetId: string,
  position: 'before' | 'after',
): Promise<WorkItem> {
  return normalizeWorkItem(
    await http.post<WorkItem & { sortOrder?: string }>(
      `/work-items/${id}/reorder`,
      { targetId, position },
    ),
  );
}

export async function deleteWorkItem(id: string): Promise<void> {
  return http.del<void>(`/work-items/${id}`);
}

export async function listSubItems(parentId: string): Promise<WorkItem[]> {
  return normalizeWorkItems(
    await http.get<(WorkItem & { sortOrder?: string })[]>(
      `/work-items/${parentId}/sub-items`,
    ),
  );
}

export async function addWorkItemLink(
  workItemId: string,
  input: { url: string; label: string },
): Promise<WorkItem> {
  return normalizeWorkItem(
    await http.post<WorkItem & { sortOrder?: string }>(
      `/work-items/${workItemId}/links`,
      input,
    ),
  );
}

export async function removeWorkItemLink(
  workItemId: string,
  linkId: string,
): Promise<WorkItem> {
  return normalizeWorkItem(
    await http.del<WorkItem & { sortOrder?: string }>(
      `/work-items/${workItemId}/links/${linkId}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Comments & activity
// ---------------------------------------------------------------------------

export async function listComments(workItemId: string): Promise<Comment[]> {
  return http.get<Comment[]>(`/work-items/${workItemId}/comments`);
}

export async function addComment(
  workItemId: string,
  bodyHtml: string,
): Promise<Comment> {
  return http.post<Comment>(`/work-items/${workItemId}/comments`, { bodyHtml });
}

export async function listActivity(
  workItemId: string,
): Promise<ActivityEntry[]> {
  return http.get<ActivityEntry[]>(`/work-items/${workItemId}/activity`);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export async function listPages(projectId: string): Promise<Page[]> {
  return http.get<Page[]>(`/projects/${projectId}/pages`);
}

export async function listAllPages(): Promise<Page[]> {
  return http.get<Page[]>('/pages');
}

export async function getPage(id: string): Promise<Page | undefined> {
  return http.get<Page | undefined>(`/pages/${id}`, {
    notFoundAsUndefined: true,
  });
}

export async function createPage(
  projectId: string,
  title = 'Untitled',
  parentPageId: string | null = null,
): Promise<Page> {
  return http.post<Page>(`/projects/${projectId}/pages`, {
    title,
    parentPageId,
  });
}

export async function updatePage(
  id: string,
  patch: Partial<Page>,
): Promise<Page> {
  return http.patch<Page>(`/pages/${id}`, patch);
}

export async function deletePage(id: string): Promise<void> {
  return http.del<void>(`/pages/${id}`);
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
  filters: Record<string, unknown>,
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
// Intake
// ---------------------------------------------------------------------------

export async function listIntake(projectId: string): Promise<IntakeRequest[]> {
  return http.get<IntakeRequest[]>(`/projects/${projectId}/intake`);
}

export interface CreateIntakeRequestInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: Priority;
  sourceName: string;
  sourceEmail: string;
}

export async function createIntakeRequest(
  input: CreateIntakeRequestInput,
): Promise<IntakeRequest> {
  return http.post<IntakeRequest>('/intake', input);
}

export async function updateIntakeStatus(
  id: string,
  status: IntakeStatus,
): Promise<IntakeRequest> {
  return http.patch<IntakeRequest>(`/intake/${id}/status`, { status });
}

export async function convertIntakeToWorkItem(
  id: string,
  stateId: string,
  overrides?: Partial<Pick<WorkItem, 'title' | 'description' | 'priority'>>,
): Promise<WorkItem> {
  return normalizeWorkItem(
    await http.post<WorkItem & { sortOrder?: string }>(
      `/intake/${id}/convert`,
      { stateId, ...overrides },
    ),
  );
}

// ---------------------------------------------------------------------------
// Stickies & notifications
// ---------------------------------------------------------------------------

export async function listStickies(): Promise<Sticky[]> {
  return http.get<Sticky[]>('/stickies');
}

export async function createSticky(
  title: string,
  body: string,
): Promise<Sticky> {
  return http.post<Sticky>('/stickies', { title, body });
}

export async function deleteSticky(id: string): Promise<void> {
  return http.del<void>(`/stickies/${id}`);
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
): Promise<CopilotProposal[]> {
  return http.get<CopilotProposal[]>(
    `/copilot/conversations/${conversationId}/proposals`,
  );
}

export async function approveCopilotProposal(
  id: string,
): Promise<CopilotProposal> {
  return http.post<CopilotProposal>(`/copilot/proposals/${id}/approve`, {});
}

export async function rejectCopilotProposal(
  id: string,
): Promise<CopilotProposal> {
  return http.post<CopilotProposal>(`/copilot/proposals/${id}/reject`, {});
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

// ---------------------------------------------------------------------------
// Dev/demo utility
// ---------------------------------------------------------------------------

export async function resetAllData(): Promise<void> {
  return http.post<void>('/dev/reset');
}

export { CURRENT_USER_ID };
