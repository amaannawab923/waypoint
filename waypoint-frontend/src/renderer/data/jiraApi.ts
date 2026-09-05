// The one integration point between "My Jira" UI code and its data — same
// contract as data/api.ts (see that file's own header comment for the tone
// this mirrors), except there is no real backend for this feature yet: every
// export here is an async function backed by in-memory fixtures, mutated by
// the mock "write" functions so the UI sees consistent results across calls.
// UI code must never reach into this module's fixture arrays directly; it
// only ever calls the exported functions below.
//
// Fixtures are the mockup's own example data verbatim (six tickets across
// three Jira projects, one already reassigned away, one mid-conflict) — see
// the My Jira mockup this was ported from for the exact source copy.

import type {
  JiraComment,
  JiraConnectionStatus,
  JiraMentionCandidate,
  JiraProjectKey,
  JiraTicket,
  JiraTransition,
  JiraTransitionField,
} from '@/types/jira';

// Every mock write/read carries an artificial delay so loading/saving states
// are real, not instant — short-circuited to 0ms under Jest (NODE_ENV=test)
// so tests stay fast, otherwise close to the mockup's own toast timings
// (~150ms for a read, 400-600ms for a write that "reaches Jira").
function delay(ms: number): Promise<void> {
  const actual = process.env.NODE_ENV === 'test' ? 0 : ms;
  return new Promise((resolve) => setTimeout(resolve, actual));
}

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

// Whether the mock connection starts already-connected. Phase 1 has no
// wizard yet (that's phase 2's job), so this defaults to `true` — the sidebar
// item and /my-jira route need to be reachable without one. Phase 2's wizard
// is expected to flip this default once it exists; this is the one place to
// change it.
const DEFAULT_JIRA_CONNECTED = true;

const CURRENT_USER_NAME = 'Max Chen';
const CURRENT_USER_INITIALS = 'MC';

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}
function secondsAgo(secs: number): string {
  return new Date(Date.now() - secs * 1000).toISOString();
}

let connectionFixture: JiraConnectionStatus = {
  connected: DEFAULT_JIRA_CONNECTED,
  accountName: CURRENT_USER_NAME,
  accountEmail: 'max@northwind.dev',
  site: 'northwind.atlassian.net',
  lastSyncAt: secondsAgo(8),
  // issueCount/projectCount below are placeholders — getJiraConnectionStatus
  // recomputes both from the live ticket list so they never drift from what
  // the list actually shows (e.g. after a tombstone is dismissed).
  issueCount: 6,
  projectCount: 3,
  pollIntervalSec: 15,
};

let ticketsFixture: JiraTicket[] = [
  {
    id: 'jira-eng-421',
    key: 'ENG-421',
    projectKey: 'ENG',
    title: 'Webhook receiver drops events past 500/min',
    role: 'assignee',
    stateName: 'In Progress',
    stateColor: 'var(--warning)',
    priority: 'urgent',
    assigneeName: 'Max Chen',
    assigneeInitials: 'MC',
    reporterName: 'Sam Lee',
    watcherNames: ['Priya Raman'],
    description:
      'Above roughly 500 events/min the receiver returns 200 but never enqueues. Reproduced on staging with a 900/min replay: 41% of events never reach the worker. Needs a real limiter with backpressure, not a silent drop.',
    epicName: 'Ingest hardening',
    storyPoints: 5,
    sprintName: 'Ingest 24',
    attachments: [
      { fileName: 'replay-900rpm.log', sizeLabel: '214 KB', uploaderName: 'Sam Lee' },
    ],
    isTombstoned: false,
    tombstone: null,
    hasConflict: false,
    conflict: null,
  },
  {
    id: 'jira-plat-88',
    key: 'PLAT-88',
    projectKey: 'PLAT',
    title: 'Backfill the events table for August',
    role: 'assignee',
    stateName: 'In Progress',
    stateColor: 'var(--warning)',
    priority: 'medium',
    assigneeName: 'Max Chen',
    assigneeInitials: 'MC',
    reporterName: 'Rob Kim',
    watcherNames: [],
    description:
      'August rows are missing from the events table after the ingest outage — needs a backfill job against the archived S3 dump.',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    attachments: [],
    isTombstoned: false,
    tombstone: null,
    hasConflict: true,
    conflict: { changedBy: 'Rob', changedAt: secondsAgo(4) },
  },
  {
    id: 'jira-grw-12',
    key: 'GRW-12',
    projectKey: 'GRW',
    title: 'Signup funnel drops 8% on mobile Safari',
    role: 'reporter',
    stateName: 'To Do',
    stateColor: 'var(--text-muted)',
    priority: 'low',
    assigneeName: 'Priya Raman',
    assigneeInitials: 'PR',
    reporterName: 'Max Chen',
    watcherNames: [],
    description:
      'Signup completion drops 8% specifically on mobile Safari 17.4 — a stack trace in Sentry points at the phone-verification step failing to submit.',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    attachments: [],
    isTombstoned: false,
    tombstone: null,
    hasConflict: false,
    conflict: null,
  },
  {
    id: 'jira-eng-388',
    key: 'ENG-388',
    projectKey: 'ENG',
    title: 'Rotate the staging database credentials',
    role: 'watcher',
    stateName: 'In Review',
    stateColor: 'var(--accent)',
    priority: 'none',
    assigneeName: 'Sam Lee',
    assigneeInitials: 'SL',
    reporterName: 'Max Chen',
    watcherNames: ['Max Chen'],
    description: 'Routine credential rotation for the staging database, scoped to the ingest and API services.',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    attachments: [],
    isTombstoned: false,
    tombstone: null,
    hasConflict: false,
    conflict: null,
  },
  {
    id: 'jira-eng-402',
    key: 'ENG-402',
    projectKey: 'ENG',
    title: 'Add a health-check endpoint to the export worker',
    role: 'assignee',
    stateName: 'To Do',
    stateColor: 'var(--text-muted)',
    priority: 'none',
    assigneeName: 'Max Chen',
    assigneeInitials: 'MC',
    reporterName: 'Sam Lee',
    watcherNames: [],
    description: 'The export worker has no liveness endpoint, so a wedged worker looks healthy to the orchestrator.',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    attachments: [],
    isTombstoned: false,
    tombstone: null,
    hasConflict: false,
    conflict: null,
  },
  {
    id: 'jira-plat-91',
    key: 'PLAT-91',
    projectKey: 'PLAT',
    title: 'Split the ingest worker into two queues',
    role: 'assignee',
    stateName: 'In Progress',
    stateColor: 'var(--warning)',
    priority: 'none',
    assigneeName: 'Priya Raman',
    assigneeInitials: 'PR',
    reporterName: 'Rob Kim',
    watcherNames: [],
    description: 'Split the single ingest queue into a fast-path and a backfill-path queue to stop head-of-line blocking.',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    attachments: [],
    isTombstoned: true,
    tombstone: { reassignedTo: 'Priya Raman', reassignedAt: minutesAgo(6) },
    hasConflict: false,
    conflict: null,
  },
];

let commentsFixture: JiraComment[] = [
  {
    id: 'jira-cmt-1',
    ticketId: 'jira-eng-421',
    authorName: 'Sam Lee',
    authorInitials: 'SL',
    body: "Replay log attached. @Max Chen this is blocking the Northwind rollout — can you take it this sprint?",
    mentions: ['Max Chen'],
    createdAt: minutesAgo(60 * 20),
    postedByWaypoint: false,
    disclosureText: null,
  },
  {
    id: 'jira-cmt-2',
    ticketId: 'jira-eng-421',
    authorName: 'Max Chen',
    authorInitials: 'MC',
    body: 'Taking it. Token bucket rather than a fixed window — fixed windows still cliff at the boundary.',
    mentions: [],
    createdAt: minutesAgo(60 * 3),
    postedByWaypoint: false,
    disclosureText: null,
  },
];

const MENTION_CANDIDATES: JiraMentionCandidate[] = [
  { name: 'Priya Raman', role: 'reviewer' },
  { name: 'Sam Lee', role: 'reporter' },
  { name: 'Rob Kim', role: 'watcher' },
];

// -----------------------------------------------------------------------
// Per-project workflows — "these are the transitions your Jira workflow
// allows... Waypoint doesn't invent them" (mockup copy). ENG and PLAT share
// a 4-state workflow (To Do / In Progress / In Review / Done); GRW's is
// simpler (no In Review). Both `requiresResolution`/`optionalTimeSpent`
// mirror exactly which transitions the mockup marks "needs a field".
// -----------------------------------------------------------------------

interface WorkflowTransitionDef {
  targetStateName: string;
  requiresResolution?: boolean;
  optionalTimeSpent?: boolean;
}

const STATE_COLOR: Record<string, string> = {
  'To Do': 'var(--text-muted)',
  'In Progress': 'var(--warning)',
  'In Review': 'var(--accent)',
  Done: 'var(--success)',
};

const RESOLUTION_OPTIONS = ['Fixed', "Won't Do", 'Duplicate', 'Cannot Reproduce'];

const ENG_WORKFLOW: Record<string, WorkflowTransitionDef[]> = {
  'To Do': [{ targetStateName: 'In Progress' }],
  'In Progress': [
    { targetStateName: 'In Review' },
    { targetStateName: 'Done', requiresResolution: true, optionalTimeSpent: true },
    { targetStateName: 'To Do' },
  ],
  'In Review': [{ targetStateName: 'Done' }],
  Done: [],
};

// "PLAT similar to ENG" (build plan) — same shape, except PLAT's own Done
// transition from In Review also requires a Resolution (ENG's doesn't).
const PLAT_WORKFLOW: Record<string, WorkflowTransitionDef[]> = {
  'To Do': [{ targetStateName: 'In Progress' }],
  'In Progress': [
    { targetStateName: 'In Review' },
    { targetStateName: 'Done', requiresResolution: true, optionalTimeSpent: true },
    { targetStateName: 'To Do' },
  ],
  'In Review': [{ targetStateName: 'Done', requiresResolution: true, optionalTimeSpent: true }],
  Done: [],
};

// GRW has no In Review state at all — the contrast with ENG/PLAT the build
// plan calls out as load-bearing.
const GRW_WORKFLOW: Record<string, WorkflowTransitionDef[]> = {
  'To Do': [
    { targetStateName: 'In Progress' },
    { targetStateName: 'Done', requiresResolution: true },
  ],
  'In Progress': [{ targetStateName: 'Done', requiresResolution: true }],
  Done: [],
};

const WORKFLOWS: Record<JiraProjectKey, Record<string, WorkflowTransitionDef[]>> = {
  ENG: ENG_WORKFLOW,
  PLAT: PLAT_WORKFLOW,
  GRW: GRW_WORKFLOW,
};

function buildTransitionFields(def: WorkflowTransitionDef): JiraTransitionField[] {
  if (!def.requiresResolution) return [];
  const fields: JiraTransitionField[] = [
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'select',
      required: true,
      options: RESOLUTION_OPTIONS,
    },
  ];
  if (def.optionalTimeSpent) {
    fields.push({
      key: 'timeSpent',
      label: 'Time spent',
      type: 'text',
      required: false,
      hint: 'Optional on this workflow.',
    });
  }
  return fields;
}

function transitionsFor(ticket: JiraTicket): JiraTransition[] {
  const defs = WORKFLOWS[ticket.projectKey][ticket.stateName] ?? [];
  return defs.map((def) => ({
    id: `${ticket.id}::${def.targetStateName.replace(/\s+/g, '-')}`,
    targetStateName: def.targetStateName,
    targetStateColor: STATE_COLOR[def.targetStateName] ?? 'var(--text-muted)',
    requiresFields: buildTransitionFields(def),
  }));
}

// -----------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------

export async function getJiraConnectionStatus(): Promise<JiraConnectionStatus> {
  await delay(150);
  const live = ticketsFixture.filter((t) => !t.isTombstoned);
  return {
    ...connectionFixture,
    issueCount: live.length,
    projectCount: new Set(live.map((t) => t.projectKey)).size,
  };
}

export async function listMyJiraTickets(): Promise<JiraTicket[]> {
  await delay(200);
  return ticketsFixture.map((t) => ({ ...t }));
}

export async function getJiraTicket(id: string): Promise<JiraTicket | undefined> {
  await delay(150);
  const found = ticketsFixture.find((t) => t.id === id);
  return found ? { ...found } : undefined;
}

export async function getJiraTransitions(ticketId: string): Promise<JiraTransition[]> {
  await delay(150);
  const ticket = ticketsFixture.find((t) => t.id === ticketId);
  if (!ticket) return [];
  return transitionsFor(ticket);
}

export async function listJiraComments(ticketId: string): Promise<JiraComment[]> {
  await delay(150);
  return commentsFixture
    .filter((c) => c.ticketId === ticketId)
    .map((c) => ({ ...c }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listJiraMentionCandidates(): Promise<JiraMentionCandidate[]> {
  await delay(80);
  return MENTION_CANDIDATES.map((c) => ({ ...c }));
}

// -----------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------

export async function connectJira(): Promise<JiraConnectionStatus> {
  await delay(900);
  connectionFixture = { ...connectionFixture, connected: true, lastSyncAt: new Date().toISOString() };
  return getJiraConnectionStatus();
}

export async function disconnectJira(): Promise<void> {
  await delay(300);
  connectionFixture = { ...connectionFixture, connected: false };
}

export async function transitionJiraTicket(
  ticketId: string,
  transitionId: string,
  fieldValues: Record<string, string>,
): Promise<JiraTicket> {
  const ticket = ticketsFixture.find((t) => t.id === ticketId);
  if (!ticket) throw new Error(`Unknown Jira ticket: ${ticketId}`);
  const transition = transitionsFor(ticket).find((t) => t.id === transitionId);
  if (!transition) throw new Error(`Unknown transition: ${transitionId}`);
  for (const field of transition.requiresFields) {
    if (field.required && !fieldValues[field.key]?.trim()) {
      throw new Error(`${field.label} is required for this transition.`);
    }
  }
  await delay(450);
  ticket.stateName = transition.targetStateName;
  ticket.stateColor = transition.targetStateColor;
  return { ...ticket };
}

export async function dismissJiraTombstone(ticketId: string): Promise<void> {
  await delay(200);
  ticketsFixture = ticketsFixture.filter((t) => t.id !== ticketId);
}

export async function resolveJiraConflict(ticketId: string): Promise<JiraTicket> {
  const ticket = ticketsFixture.find((t) => t.id === ticketId);
  if (!ticket) throw new Error(`Unknown Jira ticket: ${ticketId}`);
  await delay(600);
  // Re-reading picks up the other user's edit — in this fixture, Rob's own
  // move to In Review (matching the mockup's resolveConflict() outcome).
  ticket.hasConflict = false;
  ticket.conflict = null;
  ticket.stateName = 'In Review';
  ticket.stateColor = STATE_COLOR['In Review'];
  return { ...ticket };
}

export async function postJiraComment(ticketId: string, body: string): Promise<JiraComment> {
  await delay(500);
  const mentionNames = MENTION_CANDIDATES.map((c) => c.name).filter((name) => body.includes(`@${name}`));
  const comment: JiraComment = {
    id: `jira-cmt-${Math.random().toString(36).slice(2, 10)}`,
    ticketId,
    authorName: CURRENT_USER_NAME,
    authorInitials: CURRENT_USER_INITIALS,
    body,
    mentions: mentionNames,
    createdAt: new Date().toISOString(),
    postedByWaypoint: true,
    disclosureText: null,
  };
  commentsFixture = [...commentsFixture, comment];
  return { ...comment };
}
