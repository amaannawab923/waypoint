export type ID = string;

// No 'triage' — dropping it is C3's, see
// docs/design/waypoint-revamp-architecture.md §3.3. A ticket that arrived
// from outside now says so through Ticket.source, which is a fact about the
// ticket rather than a workflow position every project had to carry.
export type StateGroup =
  'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';

/** Where a ticket came from. Replaces what the 'triage' state group implied. */
export type TicketSource = 'manual' | 'request' | 'agent' | 'import';

export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

// The typed ticket filter (docs/design/waypoint-revamp-architecture.md
// §4.6) — a copied type mirroring waypoint-backend's
// validation/ticketFilter.schema.ts verbatim (field-for-field, same
// literal unions), since the two packages don't share a types package.
// `v` is versioned from day one. Every array field is OR'd within itself
// and AND'd against every other field; `assigneeIds` may additionally
// carry the '@me' and '@unassigned' sentinels, resolved server-side.
export interface TicketFilterQuery {
  v: 1;
  projectIds?: string[];
  stateIds?: string[];
  stateGroups?: StateGroup[];
  priorities?: Priority[];
  assigneeIds?: string[];
  creatorIds?: string[];
  labelIds?: string[];
  sprintIds?: string[];
  workstreamIds?: string[];
  sources?: TicketSource[];
  updatedBefore?: string;
  createdAfter?: string;
  text?: string;
  includeDrafts?: boolean;
  // Mirrors useTicketsView.ts's GroupBy — kept as the same string-literal
  // union rather than importing that type here, since types/entities.ts is
  // the portable entity shape and useTicketsView.ts is page-local hook
  // state. Optional so a saved view created before this field existed
  // just falls back to the toolbar's own default grouping.
  groupBy?: 'state' | 'priority' | 'workstream' | 'sprint' | 'assignee' | 'project' | 'none';
}

export type Visibility = 'public' | 'private';

export type MemberRole = 'admin' | 'member' | 'guest';

export type PlanTier = 'community' | 'pro' | 'business' | 'enterprise';

export interface Workspace {
  id: ID;
  name: string;
  slug: string;
  companySize: string;
  timezone: string;
  plan: PlanTier;
  createdAt: string;
  restrictWorkspaceCreation: boolean;
}

export interface NotificationPrefs {
  email?: boolean;
  push?: boolean;
  mentions?: boolean;
  comments?: boolean;
}

export interface Member {
  id: ID;
  workspaceId: ID;
  fullName: string;
  displayName: string;
  email: string;
  avatarColor: string;
  role: MemberRole;
  authMethod: 'email' | 'google' | 'github' | 'gitlab' | 'gitea';
  joinedAt: string;
  // profile-settings/Preferences.tsx's "First day of the week" select —
  // real, persisted state (see the 'preferences.firstDayOfWeek'
  // capability), though nothing reads it to change calendar rendering yet.
  firstDayOfWeek: 'Sunday' | 'Monday';
  // profile-settings/Notifications.tsx's toggle rows. Null means "use the
  // page's own defaults" — same absent-is-unset convention as
  // Project.estimate/automations, so a member row from before this column
  // existed doesn't need a backfill.
  notificationPrefs: NotificationPrefs | null;
}

// Replaces ProjectFeatures (docs/design/waypoint-revamp-architecture.md
// §3.4) — nav presence is derived from whether a primitive actually has
// rows, not a stored per-project flag. Keys are the primitive names.
export interface PrimitiveCounts {
  sprints: number;
  workstreams: number;
  views: number;
  docs: number;
  requests: number;
  /** Requests still pending triage — what the sidebar badge should show,
   * distinct from `requests` (every request regardless of status), which
   * only drives nav-visibility. See Sidebar.tsx. */
  requestsPending: number;
}

export type EstimateType = 'points' | 'categories';

export interface ProjectEstimateSystem {
  type: EstimateType;
  values: string[];
}

export interface ProjectAutomations {
  autoArchiveEnabled: boolean;
  autoArchiveAfterDays: number;
  autoCloseEnabled: boolean;
  autoCloseAfterDays: number;
}

export interface Project {
  id: ID;
  workspaceId: ID;
  name: string;
  identifier: string;
  description: string;
  icon: string;
  coverGradient: [string, string];
  visibility: Visibility;
  leadId: ID | null;
  defaultAssigneeId: ID | null;
  timezone: string;
  estimate: ProjectEstimateSystem | null;
  automations: ProjectAutomations;
  createdAt: string;
  archivedAt: string | null;
  memberIds: ID[];
  guestAccessEnabled: boolean;
  /** Absolute path to the linked local git checkout; null when not linked. */
  repoPath: string | null;
  /** Row counts per primitive — drives which sidebar sub-nav entries show (§3.4). */
  primitiveCounts: PrimitiveCounts;
  /** Capability: "accept submissions from outside" — distinct from a feature toggle (§3.4). */
  acceptsRequests: boolean;
}

export interface TicketState {
  id: ID;
  projectId: ID;
  name: string;
  group: StateGroup;
  color: string;
  isDefault: boolean;
  sortOrder: number;
}

export interface Label {
  id: ID;
  projectId: ID;
  name: string;
  color: string;
}

// Five values, not six: 'backlog' collapsed into 'planned', and
// 'in-progress'/'completed'/'cancelled' became 'active'/'done'/'dropped'
// (architecture §3.2 item 19).
export type WorkstreamStatus =
  'planned' | 'active' | 'paused' | 'done' | 'dropped';

export interface Workstream {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  leadId: ID | null;
  status: WorkstreamStatus;
  startDate: string | null;
  targetDate: string | null;
  memberIds: ID[];
}

export interface Sprint {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  leadId?: ID;
  memberIds?: ID[];
}

export interface TicketLink {
  id: ID;
  url: string;
  label: string;
  createdAt: string;
}

export interface Ticket {
  id: ID;
  projectId: ID;
  identifier: string; // e.g. WAY-12
  sequenceId: number;
  title: string;
  description: string;
  stateId: ID;
  priority: Priority;
  source: TicketSource;
  assigneeIds: ID[];
  labelIds: ID[];
  workstreamId: ID | null;
  sprintId: ID | null;
  parentId: ID | null;
  estimatePoints: number | null;
  estimateValue: string | null;
  startDate: string | null;
  dueDate: string | null;
  createdById: ID;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
  linkCount: number;
  links: TicketLink[];
  isDraft: boolean;
}

export interface Comment {
  id: ID;
  ticketId: ID;
  authorId: ID;
  bodyHtml: string;
  createdAt: string;
}

export type ActivityVerb =
  | 'created'
  | 'state_changed'
  | 'priority_changed'
  | 'assignee_added'
  | 'assignee_removed'
  | 'label_added'
  | 'label_removed'
  | 'commented'
  | 'start_date_set'
  | 'due_date_set'
  | 'workstream_added'
  | 'sprint_added'
  | 'subtask_added'
  | 'link_added'
  | 'agent_assigned'
  | 'agent_status_changed';

export interface ActivityEntry {
  id: ID;
  ticketId: ID;
  actorId: ID;
  verb: ActivityVerb;
  detail: string;
  createdAt: string;
}

export interface Doc {
  id: ID;
  projectId: ID;
  title: string;
  icon: string;
  contentHtml: string;
  visibility: 'public' | 'private' | 'archived';
  ownerId: ID;
  isFavorite: boolean;
  isLocked: boolean;
  parentDocId: ID | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedView {
  id: ID;
  // Nullable as of §4.6 (P3b): project scope moved into filters.projectIds,
  // so a view is no longer required to name exactly one project. Still
  // populated for views that do name exactly one (denormalized for
  // listing), null for cross-project ones.
  projectId: ID | null;
  name: string;
  ownerId: ID;
  filters: TicketFilterQuery;
  visibility: Visibility;
  isFavorite: boolean;
  updatedAt: string;
}

export type RequestStatus = 'pending' | 'accepted' | 'declined' | 'duplicate';

// Shadows the DOM's global `Request` inside every module that imports it.
// That is deliberate: nothing in this app constructs a fetch Request, and
// the product calls these Requests, so the entity gets the plain name.
export interface Request {
  id: ID;
  projectId: ID;
  title: string;
  description: string;
  status: RequestStatus;
  priority?: Priority;
  sourceName: string;
  sourceEmail: string;
  createdAt: string;
  linkedTicketId: ID | null;
}

export interface ScratchNote {
  id: ID;
  authorId: ID;
  title: string;
  body: string;
  color: string;
  updatedAt: string;
}

export interface NotificationItem {
  id: ID;
  recipientId: ID;
  actorId: ID;
  ticketId: ID | null;
  message: string;
  read: boolean;
  kind:
    | 'mention'
    | 'assigned'
    | 'comment'
    | 'state_change'
    | 'agent_needs_review'
    | 'agent_blocked';
  createdAt: string;
}

export type ExportStatus = 'completed' | 'processing' | 'failed';

export interface WorkspaceExport {
  id: ID;
  workspaceId: ID;
  scopeLabel: string;
  format: string;
  status: ExportStatus;
  createdAt: string;
}

export type WebhookEventType =
  | 'ticket.created'
  | 'ticket.updated'
  | 'ticket.deleted'
  | 'project.created'
  | 'sprint.created'
  | 'workstream.created';

export interface Webhook {
  id: ID;
  workspaceId: ID;
  url: string;
  eventTypes: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
}

export type AgentAutonomy =
  'plan-only' | 'ask-before-write' | 'ask-before-pr' | 'full-auto';

export type AgentTrigger =
  'manual' | 'on-assign' | 'on-comment-mention' | 'on-label';

// How an agent actually runs. v1 offers exactly one real, selectable value —
// 'local-claude-subscription' shells out to the Claude Code CLI already
// installed and logged into this machine, under the user's own subscription,
// never a hosted API key pasted into the app. The other members of this
// union exist so the type doesn't need to change again when a second
// execution method ships; the UI never lets a user select them yet (see
// EXECUTION_METHODS in agentTemplates.ts).
export type ExecutionMethod =
  | 'local-claude-subscription'
  | 'local-codex-subscription'
  | 'local-gemini-subscription'
  | 'hosted-api-key';

export interface AgentInstructionsFile {
  filename: string; // always ends in .md — e.g. "release-notes-bot.md"
  contentMarkdown: string; // raw markdown, the agent's literal operating brief
}

// An Agent is a sibling of Member in the assignee id space — its `id` can
// appear in Ticket.assigneeIds right alongside human member ids, so a
// ticket can have a human co-assignee and an agent doer at once. Every
// Agent row is the same shape with the same editing rights — there is no
// "built-in vs. custom" distinction; every agent is one a user defined.
export interface Agent {
  id: ID;
  workspaceId: ID;
  name: string;
  avatarColor: string;
  instructionsFile: AgentInstructionsFile;
  // scopeAllProjects is an explicit, positive choice a user must make during
  // creation — not an empty scopeProjectIds array read as "forgot to set
  // this." scopeProjectIds only matters when scopeAllProjects is false.
  scopeAllProjects: boolean;
  scopeProjectIds: ID[];
  executionMethod: ExecutionMethod;
  model: string; // e.g. "Claude Opus" — options are scoped to executionMethod's family
  autonomy: AgentAutonomy;
  triggers: AgentTrigger[];
  templateId?: string; // which starter template this was cloned from, if any — provenance only
  isActive: boolean;
  createdById: ID;
  createdAt: string;
  updatedAt: string;
}

export type AgentRunStatus =
  'queued' | 'running' | 'needs-review' | 'blocked' | 'done' | 'failed';

// Tracks one agent's run against one ticket. Kept separate from Ticket
// itself (rather than a column on it) so a ticket's own `stateId` keeps
// meaning exactly what it always has, and so re-assigning to a different
// agent later doesn't lose the previous run's history.
export interface AgentAssignment {
  id: ID;
  ticketId: ID;
  agentId: ID;
  status: AgentRunStatus;
  summary: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export type CopilotMessageRole = 'user' | 'assistant';

export interface CopilotMessage {
  id: ID;
  conversationId: ID;
  role: CopilotMessageRole;
  content: string;
  seq: number;
  createdAt: string;
}

// The list shape (issue #11) — no messages, since the list endpoint doesn't
// fetch them (see docs on useCopilotConversations.ts's lazy per-session
// message loading).
export interface CopilotConversationSummary {
  id: ID;
  memberId: ID;
  title: string;
  claudeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CopilotConversation extends CopilotConversationSummary {
  messages: CopilotMessage[];
}

// UNCHANGED from the pre-widening set, plus 'add_label' — the mockup's most
// common trust candidate (architecture §4.2). Nothing produces this kind
// yet (no propose_add_label MCP tool exists on the backend either); it's
// here so the type matches the widened backend proposal_kind enum and the
// card (CopilotProposalCard.tsx) can render one defensively once something
// does.
export type ProposalKind =
  | 'comment'
  | 'state_change'
  | 'assignee_change'
  | 'priority_change'
  | 'create_ticket'
  | 'add_label';

// Mirrors the backend's proposal_status enum. 'executing' is a transient
// claim state the renderer rarely observes (approve responds only after
// execution finishes), but a concurrent-approve echo can surface it.
// 'reverted' is the Undo path's terminal state (architecture §4.5) — no
// code produces it yet, but the type matches the enum.
export type ProposalStatus =
  | 'proposed'
  | 'executing'
  | 'executed'
  | 'rejected'
  | 'stale'
  | 'expired'
  | 'superseded'
  | 'reverted';

// Where a proposal came from — a Copilot conversation turn, or an
// autonomous agent run (architecture §4.2's workspace-scoped widening).
export type ProposalOrigin = 'copilot' | 'agent_run';

// Who/what resolved a proposal. Null while still 'proposed'.
export type ProposalDecidedBy = 'user' | 'trust_grant' | 'system';

// The kind-specific execute arguments the model proposed — which fields are
// present depends on `kind` (see CopilotProposalCard.tsx's per-kind bodies).
export interface ProposalPayload {
  body?: string; // comment
  stateId?: string; // state_change, create_ticket
  priority?: Priority; // priority_change, create_ticket
  assigneeId?: string; // assignee_change
  action?: 'add' | 'remove'; // assignee_change
  projectId?: string; // create_ticket
  title?: string; // create_ticket
  description?: string; // create_ticket
  assigneeIds?: ID[]; // create_ticket
  dueDate?: string; // create_ticket
  labelId?: string; // add_label — no real producer yet, shape is best-effort
}

// Display data captured at propose time — names and colors, never bare ids,
// so the card can render without any follow-up fetches (and keeps showing
// what was proposed even after reality moves on underneath it).
export interface ProposalSnapshot {
  identifier?: string;
  title?: string;
  itemUpdatedAt?: string;
  fromStateId?: string;
  fromStateName?: string;
  fromStateColor?: string | null;
  toStateName?: string;
  toStateColor?: string | null;
  fromPriority?: Priority;
  assigneeName?: string;
  wasAssigned?: boolean;
  currentAssigneeNames?: string[];
  projectName?: string;
  projectIdentifier?: string;
  stateName?: string;
  stateColor?: string | null;
  assigneeNames?: string[];
  labelName?: string; // add_label — best-effort, see ProposalPayload.labelId
  labelColor?: string | null; // add_label
}

// One proposal card, wherever it renders (the Copilot panel transcript, and
// — architecture §1.8/W4.2 — the Review queue, a ticket drawer, or
// Requests) — the backend's ProposalView, JSON-serialized (timestamps as
// ISO strings). No longer Copilot-conversation-specific: `conversationId`
// is non-null only for `origin === 'copilot'`.
export interface ProposalView {
  id: ID;
  conversationId: ID | null;
  kind: ProposalKind;
  ticketId: ID | null;
  payload: ProposalPayload;
  snapshot: ProposalSnapshot;
  anchorSeq: number | null;
  status: ProposalStatus;
  statusReason: string | null;
  resultInfo: unknown;
  /** The exact self-disclosure prefix an approved comment will carry — server-computed from the current user's display name. */
  disclosureText: string;
  expiresAt: string;
  modelNotifiedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  // --- workspace-scoped widening (architecture §4.2) --------------------
  origin: ProposalOrigin;
  projectId: ID;
  agentId: ID | null;
  agentRunId: ID | null;
  sourceRequestId: ID | null;
  decidedBy: ProposalDecidedBy | null;
  trustGrantId: ID | null;
  decisionLatencyMs: number | null;
}
