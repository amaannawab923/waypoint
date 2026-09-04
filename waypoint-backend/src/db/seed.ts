// Ported from waypoint-electron/src/renderer/mock/seed.ts — same ids, same
// demo dataset, just inserted via Drizzle instead of held in a JS object.
// Array-of-id fields (memberIds, assigneeIds, labelIds, scopeProjectIds) are
// expanded into their join-table rows here instead of staying inline.
//
// UX-parity note: the demo content below (projects, members, tickets,
// proposals, requests, docs, sprints, workstreams, agents, saved views,
// scratch notes) is deliberately aligned with
// docs/design/waypoint-revamp-mockup.html's own demo dataset — same project
// names, same ticket identifiers/titles, same people, same proposals — so a
// reviewer can put the running app next to the mockup and compare the same
// piece of content rather than two different fake datasets. Where the
// mockup's content has no real equivalent in the current schema (an
// agent-run origin, a "link duplicate"/"create doc"/"decline request"
// proposal kind, an agent-watches-a-view scope, a pinned Copilot session),
// it is translated to the closest supported shape rather than invented —
// see the comments at each such spot below.
import { db } from './client.js';
import * as schema from './schema/index.js';
import { sql } from 'drizzle-orm';

const now = new Date();
function daysAgo(n: number): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
function daysFromNow(n: number): Date {
  return daysAgo(-n);
}
function hoursAgo(n: number): Date {
  return new Date(now.getTime() - n * 60 * 60 * 1000);
}
function minutesAgo(n: number): Date {
  return new Date(now.getTime() - n * 60 * 1000);
}
function hoursFromNow(n: number): Date {
  return hoursAgo(-n);
}
function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const CURRENT_USER_ID = 'mem-1';

// The whole seed() body — truncate plus every insert — runs as one
// transaction (see the wrapping db.transaction() call below), so a crash
// partway through rolls back to whatever was there before instead of
// leaving a half-seeded database that seedIfEmpty.ts would then mistake
// for "already seeded" (it only checks whether `workspaces` has a row).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function truncateAll(tx: Tx) {
  const tables = [
    'proposals',
    'copilot_messages',
    'copilot_conversations',
    'agent_assignments',
    'agent_project_scopes',
    'agents',
    'workspace_exports',
    'webhooks',
    'notifications',
    'scratch_notes',
    'requests',
    'saved_views',
    'docs',
    'activity_entries',
    'comments',
    'ticket_assignees',
    'ticket_labels',
    'ticket_links',
    'tickets',
    'sprint_members',
    'sprints',
    'workstream_members',
    'workstreams',
    'labels',
    'ticket_states',
    'project_members',
    'projects',
    'members',
    'workspaces',
  ];
  await tx.execute(sql.raw(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`));
}

// ---------------------------------------------------------------------------
// Ticket generator — ported from the mockup's own makeTickets()/mulberry32()
// (docs/design/waypoint-revamp-mockup.html, search for those names) so the
// same deterministic pseudo-random title/state/priority/label/assignee mix
// the mockup renders for its 203-ticket Compass Web list and 9-ticket
// Product Launch list comes out of this seed too — computed the same way,
// not hand-copied and not re-randomized on every run. Real identifiers are
// sequential from 1 (matching tickets.service.ts's createTicket, which
// assigns `${project.identifier}-${nextSeq}`), not the mockup's own
// `count + 40 - i` scheme — that offset was an implementation detail of the
// mockup's in-memory array, not meaningful demo content, so the seven named
// tickets the mockup calls out by number (CW-121, 129, 133, 138, 140, 141,
// 142) are overlaid onto these same sequence numbers below instead.
function mulberry32(a: number) {
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GEN_STATES = ['backlog', 'todo', 'progress', 'review', 'done', 'cancelled'] as const;
const GEN_PRIOS = ['urgent', 'high', 'medium', 'low', 'none'] as const;
// Index-matched to the mockup's PEOPLE array (AN, MP, JR, SK, DT) — see the
// members inserted below, in the same order.
const GEN_PEOPLE = ['mem-1', 'mem-2', 'mem-3', 'mem-4', 'mem-5'];
// Index-matched to the mockup's AGENT_NAMES — see the agents inserted below.
const GEN_AGENTS = ['agent-triage', 'agent-code-reviewer', 'agent-release-notes'];
const GEN_LABELS = ['bug', 'perf', 'security', 'a11y', 'infra', 'ux', 'agent-flagged'];
// 'none' stands in for the mockup's '—' (no sprint/workstream picked).
const GEN_SPRINTS = ['Sprint 11', 'Sprint 12', 'Sprint 13', 'none'] as const;
const GEN_STREAMS = ['Payments', 'Onboarding', 'Platform', 'none'] as const;

const GEN_V = [
  'Fix', 'Add', 'Remove', 'Refactor', 'Investigate', 'Harden', 'Cache', 'Debounce', 'Migrate',
  'Instrument', 'Document', 'Retry', 'Validate', 'Paginate',
];
const GEN_O = [
  'the export endpoint', 'session token refresh', 'the Stripe webhook handler', 'the settings page query',
  'workspace onboarding', 'the search index', 'the ticket drawer', 'the sprint burndown job',
  'agent proposal snapshots', 'the repo picker', 'the comment renderer', 'the saved-view filter parser',
  'draft autosave', 'the notification fan-out', 'the archive sweep', 'the MCP tool schema',
  'the offline queue', 'the label editor', 'board drag persistence', 'the intake public form',
];
const GEN_Q = [
  'on Safari', 'under concurrent writes', 'for large workspaces', 'when the repo is unlinked',
  'after a branch switch', 'on first run', 'with 200+ rows', 'in the packaged build', 'when offline', '',
];

interface GenTicket {
  title: string;
  state: (typeof GEN_STATES)[number];
  priority: (typeof GEN_PRIOS)[number];
  assignee: { kind: 'member' | 'agent'; id: string } | null;
  sprintName: (typeof GEN_SPRINTS)[number];
  streamName: (typeof GEN_STREAMS)[number];
  labelNames: string[];
  daysAgoUpdated: number;
  daysAgoCreatedExtra: number;
}

function generateTickets(count: number, seed: number): GenTicket[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
  const out: GenTicket[] = [];
  for (let i = 0; i < count; i++) {
    const state = pick(GEN_STATES);
    const isAgent = rnd() < 0.17;
    const labelNames: string[] = [];
    if (rnd() < 0.75) labelNames.push(pick(GEN_LABELS));
    if (rnd() < 0.22) labelNames.push(pick(GEN_LABELS));
    const flagged = rnd() < 0.12;
    if (flagged && !labelNames.includes('agent-flagged')) labelNames.push('agent-flagged');
    const q = pick(GEN_Q);
    const assignee =
      isAgent
        ? { kind: 'agent' as const, id: pick(GEN_AGENTS) }
        : rnd() < 0.12
          ? null
          : { kind: 'member' as const, id: pick(GEN_PEOPLE) };
    out.push({
      title: pick(GEN_V) + ' ' + pick(GEN_O) + (q ? ' ' + q : ''),
      state,
      priority: pick(GEN_PRIOS),
      assignee,
      sprintName: pick(GEN_SPRINTS),
      streamName: pick(GEN_STREAMS),
      labelNames: Array.from(new Set(labelNames)),
      daysAgoUpdated: Math.floor(rnd() * 40),
      daysAgoCreatedExtra: Math.floor(rnd() * 120),
    });
  }
  return out;
}

export async function seed() {
  await db.transaction(async (tx) => {
  await truncateAll(tx);

  await tx.insert(schema.workspaces).values({
    id: 'ws-1',
    name: 'Waypoint Labs',
    slug: 'waypoint-labs',
    companySize: '2-10',
    timezone: 'UTC',
    plan: 'community',
    createdAt: daysAgo(200),
    restrictWorkspaceCreation: false,
  });

  // Members — same five people (initials, names, colors) as the mockup's
  // PEOPLE array. Emails follow amaan@waypointlabs.dev (the one the mockup
  // states, on the Profile settings screen) for the rest, since none of the
  // other four are given explicit emails anywhere in the mockup.
  await tx.insert(schema.members).values([
    {
      id: 'mem-1',
      workspaceId: 'ws-1',
      fullName: 'Amaan Nawab',
      displayName: 'Amaan',
      email: 'amaan@waypointlabs.dev',
      avatarColor: '#7d6ae8',
      role: 'admin',
      authMethod: 'email',
      joinedAt: daysAgo(200),
    },
    {
      id: 'mem-2',
      workspaceId: 'ws-1',
      fullName: 'Maya P.',
      displayName: 'Maya',
      email: 'maya@waypointlabs.dev',
      avatarColor: '#2f9e6b',
      role: 'member',
      authMethod: 'google',
      joinedAt: daysAgo(180),
    },
    {
      id: 'mem-3',
      workspaceId: 'ws-1',
      fullName: 'Jonas R.',
      displayName: 'Jonas',
      email: 'jonas@waypointlabs.dev',
      avatarColor: '#c2703a',
      role: 'member',
      authMethod: 'github',
      joinedAt: daysAgo(150),
    },
    {
      id: 'mem-4',
      workspaceId: 'ws-1',
      fullName: 'Sana K.',
      displayName: 'Sana',
      email: 'sana@waypointlabs.dev',
      avatarColor: '#3a72c2',
      role: 'member',
      authMethod: 'email',
      joinedAt: daysAgo(120),
    },
    {
      id: 'mem-5',
      workspaceId: 'ws-1',
      fullName: 'Dev T.',
      displayName: 'Dev',
      email: 'dev@waypointlabs.dev',
      avatarColor: '#a13f8f',
      role: 'member',
      authMethod: 'email',
      joinedAt: daysAgo(60),
    },
  ]);

  // Projects — Compass Web (full-featured: sprints, workstreams, a linked
  // repo) and Product Launch (deliberately sparse: tickets only, no
  // sprints/workstreams/views/docs seeded — see screen-pltickets in the
  // mockup, "this project uses only tickets ... creating the first Sprint
  // IS what puts Sprints in the nav").
  await tx.insert(schema.projects).values([
    {
      id: 'proj-cw',
      workspaceId: 'ws-1',
      name: 'Compass Web',
      identifier: 'CW',
      description: 'The main web client and its API.',
      icon: '🧭',
      coverGradientStart: '#2f6fa8',
      coverGradientEnd: '#17293c',
      visibility: 'private',
      leadId: 'mem-1',
      defaultAssigneeId: null,
      timezone: 'UTC',
      // "Sizes XS–XXL" per screen-projectsettings.
      estimate: { type: 'sizes', values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
      automations: {
        autoArchiveEnabled: true,
        autoArchiveAfterDays: 30,
        autoCloseEnabled: true,
        autoCloseAfterDays: 90,
      },
      createdAt: daysAgo(200),
      archivedAt: null,
      guestAccessEnabled: false,
      acceptsRequests: true,
      repoPath: '~/code/compass-web',
    },
    {
      id: 'proj-pl',
      workspaceId: 'ws-1',
      name: 'Product Launch',
      identifier: 'PL',
      description: 'Marketing site and launch-week coordination.',
      icon: '🚀',
      coverGradientStart: '#c2542a',
      coverGradientEnd: '#3a2314',
      visibility: 'public',
      leadId: 'mem-1',
      defaultAssigneeId: null,
      timezone: 'UTC',
      estimate: null,
      automations: {
        autoArchiveEnabled: false,
        autoArchiveAfterDays: 30,
        autoCloseEnabled: false,
        autoCloseAfterDays: 30,
      },
      createdAt: daysAgo(20),
      archivedAt: null,
      guestAccessEnabled: false,
      acceptsRequests: true,
      repoPath: null,
    },
  ]);

  await tx.insert(schema.projectMembers).values([
    ...['mem-1', 'mem-2', 'mem-3', 'mem-4', 'mem-5'].map((memberId) => ({ projectId: 'proj-cw', memberId })),
    { projectId: 'proj-pl', memberId: 'mem-1' },
  ]);

  // Six states per project — Backlog / Todo / In Progress / In Review /
  // Done / Cancelled — matching the mockup's own STATES array exactly
  // (there is no seventh "Triage" group; see projects.ts's stateGroupEnum
  // comment on why that was dropped).
  function statesFor(projectId: string, p: string) {
    const base = [
      { id: `st-${p}-backlog`, name: 'Backlog', group: 'backlog' as const, color: '#9c9280', isDefault: true, sortOrder: 0 },
      { id: `st-${p}-todo`, name: 'Todo', group: 'unstarted' as const, color: '#7d8a9c', isDefault: true, sortOrder: 1 },
      { id: `st-${p}-progress`, name: 'In Progress', group: 'started' as const, color: '#c99a2e', isDefault: true, sortOrder: 2 },
      { id: `st-${p}-review`, name: 'In Review', group: 'started' as const, color: '#a86fe0', isDefault: false, sortOrder: 3 },
      { id: `st-${p}-done`, name: 'Done', group: 'completed' as const, color: '#2f7a4f', isDefault: true, sortOrder: 4 },
      { id: `st-${p}-cancelled`, name: 'Cancelled', group: 'cancelled' as const, color: '#b7332a', isDefault: true, sortOrder: 5 },
    ];
    return base.map((s) => ({ ...s, projectId }));
  }
  await tx.insert(schema.ticketStates).values([...statesFor('proj-cw', 'cw'), ...statesFor('proj-pl', 'pl')]);

  const CW_STATE: Record<(typeof GEN_STATES)[number], string> = {
    backlog: 'st-cw-backlog',
    todo: 'st-cw-todo',
    progress: 'st-cw-progress',
    review: 'st-cw-review',
    done: 'st-cw-done',
    cancelled: 'st-cw-cancelled',
  };
  const PL_STATE: Record<(typeof GEN_STATES)[number], string> = {
    backlog: 'st-pl-backlog',
    todo: 'st-pl-todo',
    progress: 'st-pl-progress',
    review: 'st-pl-review',
    done: 'st-pl-done',
    cancelled: 'st-pl-cancelled',
  };

  // Seven labels per project — bug/perf/security/a11y/infra/ux/agent-flagged
  // — matching the mockup's LABELS array and screen-projectsettings' "7
  // labels" line exactly. Product Launch gets its own copies of the same
  // set (the mockup's generator draws PL tickets from the same shared
  // LABELS array too), not a shared row, since labels are per-project.
  function labelsFor(projectId: string, p: string) {
    const base = [
      { name: 'bug', color: '#b7332a' },
      { name: 'perf', color: '#c99a2e' },
      { name: 'security', color: '#a86fe0' },
      { name: 'a11y', color: '#2f6fa8' },
      { name: 'infra', color: '#9c9280' },
      { name: 'ux', color: '#2f7a4f' },
      { name: 'agent-flagged', color: '#a4650b' },
    ];
    return base.map((l) => ({ id: `lbl-${p}-${l.name}`, projectId, name: l.name, color: l.color }));
  }
  await tx.insert(schema.labels).values([...labelsFor('proj-cw', 'cw'), ...labelsFor('proj-pl', 'pl')]);
  const CW_LABEL = (name: string) => `lbl-cw-${name}`;
  const PL_LABEL = (name: string) => `lbl-pl-${name}`;

  // Workstreams — Compass Web only. Payments and Onboarding are the two
  // cards shown on screen-workstreams; Platform is a third value the
  // mockup's own STREAMS array draws from (and CW-142's override assigns
  // it) but never renders a card for — description below is inferred from
  // the platform/auth-shaped tickets that land in it (CW-141, CW-142), not
  // stated verbatim in the mockup.
  await tx.insert(schema.workstreams).values([
    {
      id: 'ws-cw-payments',
      projectId: 'proj-cw',
      name: 'Payments',
      description: 'Stripe client, webhook retry, idempotency keys.',
      leadId: 'mem-1',
      status: 'active',
      startDate: dateOnly(daysAgo(90)),
      targetDate: dateOnly(daysFromNow(30)),
    },
    {
      id: 'ws-cw-onboarding',
      projectId: 'proj-cw',
      name: 'Onboarding',
      description: 'Signup, first-run, workspace creation.',
      leadId: 'mem-2',
      status: 'active',
      startDate: dateOnly(daysAgo(60)),
      targetDate: dateOnly(daysFromNow(45)),
    },
    {
      id: 'ws-cw-platform',
      projectId: 'proj-cw',
      name: 'Platform',
      description: 'Auth, sessions, and shared platform services.',
      leadId: null,
      status: 'active',
      startDate: dateOnly(daysAgo(150)),
      targetDate: null,
    },
  ]);
  await tx.insert(schema.workstreamMembers).values([
    { workstreamId: 'ws-cw-payments', memberId: 'mem-1' },
    { workstreamId: 'ws-cw-onboarding', memberId: 'mem-2' },
  ]);
  const CW_STREAM: Record<(typeof GEN_STREAMS)[number], string | null> = {
    Payments: 'ws-cw-payments',
    Onboarding: 'ws-cw-onboarding',
    Platform: 'ws-cw-platform',
    none: null,
  };

  // Sprints — Compass Web only, matching screen-sprints (Sprint 12 active,
  // Aug 28 – Sep 11, "ends in 4 days"; Sprint 13 upcoming) and the Archive
  // screen's "Sprint 10 · completed". Sprint 11 (whose closed tickets the
  // Release Notes agent drafted release notes from — see the r1 proposal
  // below) is the one immediately before Sprint 12. Dates are anchored
  // relative to *now* rather than hand-copying "Aug 28 – Sep 11" literally,
  // so Sprint 12 stays "active" (and Sprint 13 "upcoming") whenever this
  // seed actually runs, not only if it runs on the mockup's own date.
  await tx.insert(schema.sprints).values([
    {
      id: 'sp-cw-10',
      projectId: 'proj-cw',
      name: 'Sprint 10',
      description: 'Completed.',
      startDate: dateOnly(daysAgo(34)),
      endDate: dateOnly(daysAgo(20)),
    },
    {
      id: 'sp-cw-11',
      projectId: 'proj-cw',
      name: 'Sprint 11',
      description: 'Closed — release notes drafted by the Release Notes agent.',
      startDate: dateOnly(daysAgo(20)),
      endDate: dateOnly(daysAgo(6)),
    },
    {
      id: 'sp-cw-12',
      projectId: 'proj-cw',
      name: 'Sprint 12',
      description: '',
      startDate: dateOnly(daysAgo(6)),
      endDate: dateOnly(daysFromNow(8)),
    },
    {
      id: 'sp-cw-13',
      projectId: 'proj-cw',
      name: 'Sprint 13',
      description: '',
      startDate: dateOnly(daysFromNow(8)),
      endDate: dateOnly(daysFromNow(22)),
    },
  ]);
  const CW_SPRINT: Record<(typeof GEN_SPRINTS)[number], string | null> = {
    'Sprint 11': 'sp-cw-11',
    'Sprint 12': 'sp-cw-12',
    'Sprint 13': 'sp-cw-13',
    none: null,
  };

  // --- Tickets -----------------------------------------------------------
  type WiSeed = {
    id: string;
    projectId: string;
    title: string;
    description?: string;
    stateId: string;
    priority: (typeof schema.priorityEnum.enumValues)[number];
    source?: (typeof schema.ticketSourceEnum.enumValues)[number];
    assigneeIds?: { id: string; kind: 'member' | 'agent' }[];
    labelIds?: string[];
    workstreamId?: string | null;
    sprintId?: string | null;
    createdAt: Date;
    updatedAt: Date;
  };

  let seq = 0;
  const wiSeeds: WiSeed[] = [];
  function wi(projectId: string, seedNo: number, w: Omit<WiSeed, 'id' | 'projectId'>): WiSeed {
    seq += 1;
    const s: WiSeed = { id: `wi-${seq}`, projectId, ...w };
    wiSeeds.push(s);
    return s;
  }

  // 203 Compass Web tickets and 9 Product Launch tickets, generated with
  // the same seeds the mockup uses (CW_TICKETS = makeTickets('CW', ...,
  // 203, 20260903); PL_TICKETS = makeTickets('PL', ..., 9, 77120)).
  const cwGenerated = generateTickets(203, 20260903);
  const plGenerated = generateTickets(9, 77120);

  // Named tickets the mockup calls out by identifier — overlaid onto the
  // generated array at the matching sequence number (see the generator's
  // own comment above for why the *number* is preserved but not the
  // mockup's internal array order). Everything not mentioned by the mockup
  // for a given field (e.g. CW-133's priority) is left as the generator
  // produced it rather than invented.
  const cwOverrides: Record<number, Partial<GenTicket> & { description?: string }> = {
    121: { title: 'Migrate build to esbuild', state: 'done', priority: 'low', daysAgoUpdated: 32 },
    129: { title: 'Harden the comment renderer', state: 'todo', priority: 'low', labelNames: ['security'] },
    133: { title: 'Paginate the search index', state: 'todo' },
    138: {
      title: 'Add rate limiting to the export endpoint',
      state: 'progress',
      priority: 'high',
      labelNames: ['infra'],
      daysAgoUpdated: 0,
    },
    140: {
      title: 'Auth flow redesign notes',
      // state/priority aren't stated by the mockup (only that the 'ux'
      // label landed via the approved r2 proposal below) — nudged to a
      // coherent combination rather than leaving whatever the generator's
      // random pick happened to land on for this slot.
      state: 'todo',
      priority: 'medium',
      labelNames: ['ux'],
      daysAgoUpdated: 1,
    },
    141: {
      title: 'Retry webhook delivery',
      state: 'progress',
      priority: 'high',
      labelNames: ['bug'],
      streamName: 'Payments',
      assignee: { kind: 'agent', id: 'agent-code-reviewer' },
      daysAgoUpdated: 0,
    },
    142: {
      title: 'Fix session token refresh race',
      state: 'progress',
      priority: 'urgent',
      labelNames: ['bug', 'agent-flagged'],
      streamName: 'Platform',
      sprintName: 'Sprint 12',
      assignee: { kind: 'member', id: 'mem-1' },
      daysAgoUpdated: 0,
      description:
        "Two tabs refreshing at once both write the new token, and the loser's request replays with a token that has already been rotated.",
    },
  };
  const plOverrides: Record<number, Partial<GenTicket>> = {
    4: { title: 'Draft the launch-week timeline', state: 'todo', priority: 'medium', assignee: { kind: 'member', id: 'mem-1' } },
  };

  const cwTicketBySeq = new Map<number, WiSeed>();
  cwGenerated.forEach((g, idx) => {
    const seqNo = idx + 1;
    const merged = { ...g, ...cwOverrides[seqNo] };
    const createdAt = daysAgo(merged.daysAgoUpdated + merged.daysAgoCreatedExtra);
    const updatedAt = daysAgo(merged.daysAgoUpdated);
    const s = wi('proj-cw', seqNo, {
      title: merged.title,
      description: (cwOverrides[seqNo] as { description?: string } | undefined)?.description,
      stateId: CW_STATE[merged.state],
      priority: merged.priority,
      assigneeIds: merged.assignee ? [merged.assignee] : [],
      labelIds: merged.labelNames.map((n) => CW_LABEL(n)),
      workstreamId: CW_STREAM[merged.streamName],
      sprintId: CW_SPRINT[merged.sprintName],
      createdAt,
      updatedAt,
    });
    cwTicketBySeq.set(seqNo, s);
  });

  const plTicketBySeq = new Map<number, WiSeed>();
  plGenerated.forEach((g, idx) => {
    const seqNo = idx + 1;
    const merged = { ...g, ...plOverrides[seqNo] };
    const createdAt = daysAgo(merged.daysAgoUpdated + merged.daysAgoCreatedExtra);
    const updatedAt = daysAgo(merged.daysAgoUpdated);
    const s = wi('proj-pl', seqNo, {
      title: merged.title,
      stateId: PL_STATE[merged.state],
      priority: merged.priority,
      assigneeIds: merged.assignee ? [merged.assignee] : [],
      // Product Launch is deliberately sparse — no sprints/workstreams
      // exist for it yet, so every PL ticket ignores the generator's
      // sprint/stream pick regardless of what it rolled.
      workstreamId: null,
      sprintId: null,
      labelIds: merged.labelNames.map((n) => PL_LABEL(n)),
      createdAt,
      updatedAt,
    });
    plTicketBySeq.set(seqNo, s);
  });

  const prefixFor = (projectId: string) => (projectId === 'proj-cw' ? 'CW' : 'PL');
  const wiByProjectSeq = new Map<string, number>();
  await tx.insert(schema.tickets).values(
    wiSeeds.map((w, i) => {
      const count = (wiByProjectSeq.get(w.projectId) ?? 0) + 1;
      wiByProjectSeq.set(w.projectId, count);
      return {
        id: w.id,
        projectId: w.projectId,
        identifier: `${prefixFor(w.projectId)}-${count}`,
        sequenceId: count,
        title: w.title,
        description: w.description ?? '',
        stateId: w.stateId,
        priority: w.priority,
        source: w.source ?? 'manual',
        workstreamId: w.workstreamId ?? null,
        sprintId: w.sprintId ?? null,
        createdById: 'mem-1',
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        isDraft: false,
        sortOrder: String(i * 1000),
      };
    }),
  );

  const labelRows = wiSeeds.flatMap((w) => (w.labelIds ?? []).map((labelId) => ({ ticketId: w.id, labelId })));
  if (labelRows.length) await tx.insert(schema.ticketLabels).values(labelRows);

  const assigneeRows = wiSeeds.flatMap((w) =>
    (w.assigneeIds ?? []).map((a) => ({ ticketId: w.id, assigneeId: a.id, assigneeKind: a.kind })),
  );
  if (assigneeRows.length) await tx.insert(schema.ticketAssignees).values(assigneeRows);

  // Handles into the named tickets, for everything below (comments,
  // activity, proposals, notifications, requests) that targets one by id.
  const cw121 = cwTicketBySeq.get(121)!;
  const cw129 = cwTicketBySeq.get(129)!;
  const cw133 = cwTicketBySeq.get(133)!;
  const cw138 = cwTicketBySeq.get(138)!;
  const cw140 = cwTicketBySeq.get(140)!;
  const cw141 = cwTicketBySeq.get(141)!;
  const cw142 = cwTicketBySeq.get(142)!;
  const pl4 = plTicketBySeq.get(4)!;

  // --- Agents -------------------------------------------------------------
  // Triage Agent / Code Reviewer / Release Notes, per screen-agents and
  // screen-agentdetail — replacing the previous demo agents (Ethan/Dan/
  // Alice/Sam), which had no mockup basis. All three "read your repo and
  // propose; they never write" (screen-agents), so — unlike the agents this
  // replaces — none of them gets an agent_assignments row: that table
  // models an autonomous coding agent opening PRs, which is a different,
  // propose-nothing-approve-everything model than these three.
  await tx.insert(schema.agents).values([
    {
      id: 'agent-triage',
      workspaceId: 'ws-1',
      name: 'Triage Agent',
      avatarColor: '#1c5fc4',
      instructionsFilename: 'agent.md',
      instructionsContentMarkdown:
        '# Triage Agent\n\nSearch open and closed tickets for a likely duplicate before drafting a new one.\nIf none found, draft with a suggested state, priority and workstream.\nNever close or reassign an existing ticket without approval.',
      // Scoped to all projects — it triages requests from both Compass Web
      // (p1, p2 below) and Product Launch (p5 below).
      scopeAllProjects: true,
      executionMethod: 'local-claude-subscription',
      model: 'Claude',
      autonomy: 'ask-before-write',
      triggers: ['on-request'],
      isActive: true,
      createdById: CURRENT_USER_ID,
      createdAt: daysAgo(60),
      updatedAt: daysAgo(1),
    },
    {
      id: 'agent-code-reviewer',
      workspaceId: 'ws-1',
      name: 'Code Reviewer',
      avatarColor: '#a86fe0',
      instructionsFilename: 'agent.md',
      instructionsContentMarkdown:
        '# Code Reviewer\n\nFlags changes to the Stripe client for human review.',
      scopeAllProjects: false,
      executionMethod: 'local-claude-subscription',
      model: 'Claude',
      autonomy: 'ask-before-pr',
      triggers: ['on-label'],
      isActive: true,
      createdById: CURRENT_USER_ID,
      createdAt: daysAgo(45),
      updatedAt: daysAgo(0),
    },
    {
      id: 'agent-release-notes',
      workspaceId: 'ws-1',
      name: 'Release Notes',
      avatarColor: '#c99a2e',
      instructionsFilename: 'agent.md',
      instructionsContentMarkdown:
        "# Release Notes\n\nDrafts release notes from a sprint's closed tickets.",
      scopeAllProjects: false,
      executionMethod: 'local-claude-subscription',
      model: 'Claude',
      autonomy: 'full-auto',
      triggers: ['on-sprint-close'],
      templateId: 'release-notes-writer',
      // "Configured, not yet running" per screen-agents.
      isActive: false,
      createdById: CURRENT_USER_ID,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(1),
    },
  ]);
  await tx.insert(schema.agentProjectScopes).values([
    { agentId: 'agent-code-reviewer', projectId: 'proj-cw' },
    { agentId: 'agent-release-notes', projectId: 'proj-cw' },
  ]);

  // --- Comments & activity -------------------------------------------------
  // CW-142 is the ticket the mockup's ticket drawer opens by default
  // (id="tdId">CW-142 in the HTML), so its static comment/activity content
  // is attributed to CW-142 here.
  await tx.insert(schema.comments).values([
    {
      id: 'cm-1',
      ticketId: cw142.id,
      authorId: 'mem-2',
      // Plain text, no markup: a human comment's bodyHtml is whatever the
      // comment textarea posted verbatim (see TicketDetailPage.tsx's
      // handlePostComment), and the ticket drawer deliberately renders
      // human-authored bodyHtml as plain text rather than trusting it as
      // HTML (see TicketDetailPage.test.tsx's "stored XSS fix" suite) —
      // a real human comment can never contain actual markup. A literal
      // "<p>...</p>" here used to render as visible, literal tag text on
      // CW-142 instead of formatted text.
      bodyHtml: "Repro'd locally — it's the localStorage write, not the request itself.",
      createdAt: hoursAgo(2),
    },
  ]);
  await tx.insert(schema.activityEntries).values([
    { id: 'act-cw142-created', ticketId: cw142.id, actorId: 'mem-1', verb: 'created', detail: 'created the ticket', createdAt: cw142.createdAt },
    { id: 'act-cw142-assignee', ticketId: cw142.id, actorId: 'mem-1', verb: 'assignee_added', detail: 'assigned', createdAt: daysAgo(1) },
    { id: 'act-cw142-state', ticketId: cw142.id, actorId: 'mem-1', verb: 'state_changed', detail: 'changed state to In Progress', createdAt: hoursAgo(3) },
  ]);

  // --- Docs ----------------------------------------------------------------
  // Compass Web only — Product Launch stays sparse. "Sprint 11 — release
  // notes" is the doc the r1 proposal below creates (Release Notes agent,
  // auto-approved); docs.ownerId has no agent-authorship concept (member
  // only), so it is attributed to Amaan rather than left ownerless.
  await tx.insert(schema.docs).values([
    {
      id: 'doc-auth-flow',
      projectId: 'proj-cw',
      title: 'Auth flow redesign',
      icon: '📄',
      contentHtml: '<p></p>',
      visibility: 'public',
      ownerId: 'mem-2',
      isFavorite: false,
      isLocked: false,
      parentDocId: null,
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
    },
    {
      id: 'doc-q3-retro',
      projectId: 'proj-cw',
      title: 'Q3 retro',
      icon: '📄',
      contentHtml: '<p></p>',
      visibility: 'public',
      ownerId: 'mem-1',
      isFavorite: false,
      isLocked: false,
      parentDocId: null,
      createdAt: daysAgo(21),
      updatedAt: daysAgo(21),
    },
    {
      id: 'doc-payments-webhook',
      projectId: 'proj-cw',
      title: 'Payments webhook contract',
      icon: '📄',
      contentHtml: '<p></p>',
      visibility: 'public',
      ownerId: 'mem-1',
      isFavorite: false,
      isLocked: false,
      parentDocId: null,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(30),
    },
    {
      id: 'doc-sprint11-release-notes',
      projectId: 'proj-cw',
      title: 'Sprint 11 — release notes',
      icon: '🤖',
      contentHtml: '<p></p>',
      visibility: 'public',
      ownerId: 'mem-1',
      isFavorite: false,
      isLocked: false,
      parentDocId: null,
      createdAt: daysAgo(6),
      updatedAt: daysAgo(6),
    },
  ]);

  // --- Saved views -----------------------------------------------------
  // Compass Web only, matching screen-views' four rows exactly. "state:
  // !done" has no direct negation in ticketFilterSchema, so it is
  // translated to the positive set of not-done state groups. The mockup's
  // "Watched by Triage Agent / Code Reviewer" pill (an agent-watches-a-view
  // scope) has no column on either agents or saved_views today — agents
  // only scope by project (agentProjectScopes) — so that attribution is
  // documented here rather than persisted.
  await tx.insert(schema.savedViews).values([
    {
      id: 'view-cw-my-open',
      projectId: 'proj-cw',
      name: 'My open tickets',
      ownerId: 'mem-1',
      filters: { v: 1, assigneeIds: ['@me'], stateGroups: ['backlog', 'unstarted', 'started'] },
      visibility: 'public',
      isFavorite: true,
      updatedAt: daysAgo(3),
    },
    {
      id: 'view-cw-needs-triage',
      projectId: 'proj-cw',
      name: 'Needs triage review',
      ownerId: 'mem-1',
      // Watched by Triage Agent (see comment above — not a persisted link).
      filters: { v: 1, labelIds: [CW_LABEL('agent-flagged')] },
      visibility: 'public',
      isFavorite: false,
      updatedAt: daysAgo(1),
    },
    {
      id: 'view-cw-security',
      projectId: 'proj-cw',
      name: 'Security-labelled',
      ownerId: 'mem-1',
      // Watched by Code Reviewer (see comment above — not a persisted link).
      filters: { v: 1, labelIds: [CW_LABEL('security')] },
      visibility: 'public',
      isFavorite: false,
      updatedAt: daysAgo(4),
    },
    {
      id: 'view-cw-stale',
      projectId: 'proj-cw',
      name: 'Stale over 30 days',
      ownerId: 'mem-1',
      filters: { v: 1, updatedBefore: '-30d', stateGroups: ['backlog', 'unstarted', 'started'] },
      visibility: 'public',
      isFavorite: false,
      updatedAt: daysAgo(10),
    },
  ]);

  // --- Requests --------------------------------------------------------
  // Four rows — one per proposal below whose `source: 'Requests'` field (or,
  // for the spam one, its "Decline request" kind) ties it back to an
  // incoming request. The mockup's Requests sidebar badge shows "5"; only
  // four concrete requests have any content anywhere in the mockup, so this
  // seed matches the content it can find rather than padding to 5 — see the
  // seed report for this and the other counts (6/2/12 proposals, "4
  // members") that don't reconcile with the mockup's own concrete rows.
  await tx.insert(schema.requests).values([
    {
      id: 'req-cw-settings-n1',
      projectId: 'proj-cw',
      title: 'Settings page N+1 query on load',
      description: 'Settings page loads noticeably slowly for larger workspaces.',
      status: 'pending',
      sourceName: 'Beta user (external)',
      sourceEmail: 'user@example.com',
      createdAt: minutesAgo(12),
      linkedTicketId: null,
    },
    {
      id: 'req-cw-safari-export',
      projectId: 'proj-cw',
      title: 'Export button does nothing on Safari',
      description: 'Clicking export on Safari produces no download and no error.',
      status: 'duplicate',
      sourceName: 'Beta user (external)',
      sourceEmail: 'other@example.com',
      createdAt: minutesAgo(18),
      linkedTicketId: cw138.id,
    },
    {
      id: 'req-pl-pricing-claim',
      projectId: 'proj-pl',
      title: 'Pricing page: "no per-seat AI" claim needs a source',
      description: '',
      status: 'pending',
      sourceName: 'Beta user (external)',
      sourceEmail: 'user@example.com',
      createdAt: hoursAgo(4),
      linkedTicketId: null,
    },
    {
      id: 'req-cw-spam',
      projectId: 'proj-cw',
      title: 'Spam request from the public form',
      description: '',
      status: 'declined',
      sourceName: 'Anonymous',
      sourceEmail: '',
      createdAt: hoursAgo(19),
      linkedTicketId: null,
    },
  ]);

  // --- Scratchpad ------------------------------------------------------
  await tx.insert(schema.scratchNotes).values([
    {
      id: 'sk-1',
      authorId: CURRENT_USER_ID,
      title: 'Ask Maya about the Q4 roadmap review date',
      body: '',
      color: '#a4650b',
      updatedAt: daysAgo(1),
    },
    {
      id: 'sk-2',
      authorId: CURRENT_USER_ID,
      title: 'Demo script for Friday — cover Requests triage first',
      body: '',
      color: '#1c5fc4',
      updatedAt: daysAgo(2),
    },
  ]);

  // --- Notifications -----------------------------------------------------
  await tx.insert(schema.notifications).values([
    {
      id: 'nt-1',
      recipientId: CURRENT_USER_ID,
      actorId: 'agent-triage',
      ticketId: null,
      message: 'proposed creating "Settings page N+1 query on load" from a request',
      read: false,
      kind: 'agent_needs_review',
      createdAt: minutesAgo(12),
    },
    {
      id: 'nt-2',
      recipientId: CURRENT_USER_ID,
      actorId: 'mem-2',
      ticketId: cw140.id,
      message: 'mentioned you on "Auth flow redesign notes"',
      read: false,
      kind: 'mention',
      createdAt: hoursAgo(1),
    },
    {
      id: 'nt-3',
      recipientId: CURRENT_USER_ID,
      actorId: 'mem-1',
      ticketId: cw138.id,
      message: 'moved "Add rate limiting to the export endpoint" to In Progress',
      read: true,
      kind: 'state_change',
      createdAt: hoursAgo(3),
    },
    {
      id: 'nt-4',
      recipientId: CURRENT_USER_ID,
      actorId: 'agent-code-reviewer',
      ticketId: cw141.id,
      message: 'is blocked on "Retry webhook delivery"',
      read: true,
      kind: 'agent_blocked',
      createdAt: hoursAgo(5),
    },
  ]);

  // --- Copilot conversations ---------------------------------------------
  // Six sessions: the five named in the Copilot panel's session list
  // ("Safari export bug", "Token refresh race", "Why is the settings page
  // slow", "Webhook retry semantics", "Q3 retro summary") plus one more
  // ("Pricing page AI claim") needed only because every proposal requires a
  // real conversationId to satisfy the FK (proposals.conversationId is
  // non-null for origin='copilot', the only origin this schema can execute
  // today — see the note on PROPOSALS below) — Product Launch's proposal
  // has no other session to attach to. The mockup's pin/current highlight
  // on these sessions is a UI-only state with no column on
  // copilot_conversations, so it isn't persisted here.
  const convRows = await tx
    .insert(schema.copilotConversations)
    .values([
      { id: 'conv-safari-bug', memberId: 'mem-1', title: 'Safari export bug', createdAt: hoursAgo(20), updatedAt: minutesAgo(18) },
      { id: 'conv-token-refresh', memberId: 'mem-1', title: 'Token refresh race', createdAt: hoursAgo(3), updatedAt: hoursAgo(2) },
      { id: 'conv-settings-slow', memberId: 'mem-1', title: 'Why is the settings page slow', createdAt: hoursAgo(1), updatedAt: minutesAgo(12) },
      { id: 'conv-webhook-retry', memberId: 'mem-1', title: 'Webhook retry semantics', createdAt: daysAgo(2), updatedAt: hoursAgo(1) },
      { id: 'conv-q3-retro', memberId: 'mem-1', title: 'Q3 retro summary', createdAt: daysAgo(6), updatedAt: hoursAgo(4) },
      { id: 'conv-pricing-claim', memberId: 'mem-1', title: 'Pricing page AI claim', createdAt: hoursAgo(4), updatedAt: hoursAgo(4) },
    ])
    .returning({ id: schema.copilotConversations.id });
  void convRows;

  // Message content is taken verbatim from the mockup's Copilot panel where
  // it exists (Safari export bug); the other sessions get a minimal
  // grounding turn built from the same evidence/why text as their proposal
  // below, not invented dialogue.
  async function seedTurn(conversationId: string, userText: string, assistantText: string) {
    const rows = await tx
      .insert(schema.copilotMessages)
      .values([
        { id: `${conversationId}-u1`, conversationId, role: 'user', content: userText },
        { id: `${conversationId}-a1`, conversationId, role: 'assistant', content: assistantText },
      ])
      .returning({ seq: schema.copilotMessages.seq });
    return Number(rows[rows.length - 1].seq);
  }

  const seqSafari = await seedTurn(
    'conv-safari-bug',
    'why does the export button silently fail on Safari?',
    'Found it — src/export/download.ts:42 uses a Blob URL pattern Safari revokes before the click fires. I can draft a ticket, and there is an existing ticket on the same code path.',
  );
  const seqToken = await seedTurn(
    'conv-token-refresh',
    'what does the token refresh race look like exactly?',
    'The write is not guarded — two tabs both pass the freshness check before either writes.',
  );
  const seqSettings = await seedTurn(
    'conv-settings-slow',
    'why is the settings page slow to load?',
    'Not a duplicate of anything open. The loader fetches one row per project inside a map — src/settings/loader.ts:88.',
  );
  const seqWebhook = await seedTurn(
    'conv-webhook-retry',
    'is the webhook retry change safe to move to review?',
    'Backoff and the 3-attempt cap are implemented and tested; the Stripe-client touch needs a human.',
  );
  const seqQ3 = await seedTurn(
    'conv-q3-retro',
    'anything else worth flagging from the comment renderer?',
    'The comment box posts a raw textarea as bodyHtml and renders it with dangerouslySetInnerHTML.',
  );
  const seqPricing = await seedTurn(
    'conv-pricing-claim',
    'can you check the pricing page copy against what we actually ship?',
    'Flagged from a request; no repo is linked to this project, so this is text-only reasoning.',
  );

  // --- Proposals -----------------------------------------------------------
  // Every proposal below has origin: 'copilot' — the only origin this
  // schema can execute today (proposals.agentRunId has no backing
  // agent_runs table yet; see proposals.ts's own comment). The mockup
  // attributes each of these to a named AGENT ("Triage Agent", "Code
  // Reviewer", "Release Notes") rather than a Copilot chat turn from
  // Amaan — proposals.agentId is a plain, un-FK'd column independent of
  // origin, so it is set here to carry that attribution (and the Review
  // queue's Agent filter) even though conversationId/anchorSeq still point
  // at a real copilot_conversations row to satisfy the schema.
  //
  // Kind translation, since proposalKindEnum only has comment / state_change
  // / assignee_change / priority_change / create_ticket / add_label:
  //  - "Link duplicate" (p2) -> comment (ticket_links has no ticket-to-
  //    ticket relation; the closest real effect is a comment noting the
  //    dup).
  //  - "Create doc" (r1) -> not seeded as a proposal at all (no create_doc
  //    kind); the doc itself is seeded directly above.
  //  - "Decline request" (r4) -> not seeded as a proposal; requests.status
  //    already models "declined" directly (see req-cw-spam above).
  //  - The "Blocked" segment (b1/b2 in the mockup) is not seeded at all:
  //    proposals.service.ts's computeReviewQueueCounts hardcodes
  //    blocked: 0 pending agent_runs infrastructure that doesn't exist, so
  //    a seeded row here could never surface on the real Blocked tab
  //    regardless of its status — this is a genuine capability gap versus
  //    the mockup, not a data simplification.
  //  - p3's single card (state_change + assignee_change in one) becomes two
  //    real proposal rows (p3 and p3b) — one payload per kind, per the
  //    schema.

  const CW_STATE_REVIEW = 'st-cw-review';
  const CW_STATE_PROGRESS = 'st-cw-progress';

  await tx.insert(schema.proposals).values([
    {
      id: 'prop-p1',
      origin: 'copilot',
      conversationId: 'conv-settings-slow',
      anchorSeq: seqSettings,
      agentId: 'agent-triage',
      projectId: 'proj-cw',
      sourceRequestId: 'req-cw-settings-n1',
      kind: 'create_ticket',
      ticketId: null,
      payload: { projectId: 'proj-cw', title: 'Settings page N+1 query on load', stateId: CW_STATE.backlog, priority: 'medium' },
      // Shape matches proposeCreateTicketHandler's real snapshot
      // (projectName/projectIdentifier/stateName/stateColor/assigneeNames) —
      // CopilotProposalCard reads those fields, not the raw ids in payload.
      snapshot: {
        projectName: 'Compass Web',
        projectIdentifier: 'CW',
        stateName: 'Backlog',
        stateColor: '#9c9280',
        assigneeNames: [],
        evidence: 'src/settings/loader.ts:88',
        why: 'Not a duplicate of anything open. The loader fetches one row per project inside a map.',
        agentName: 'Triage Agent',
      },
      status: 'proposed',
      expiresAt: hoursFromNow(24 - 0.2),
      createdAt: minutesAgo(12),
    },
    {
      id: 'prop-p2',
      origin: 'copilot',
      conversationId: 'conv-safari-bug',
      anchorSeq: seqSafari,
      agentId: 'agent-triage',
      projectId: 'proj-cw',
      sourceRequestId: 'req-cw-safari-export',
      kind: 'comment',
      ticketId: cw138.id,
      payload: { body: 'Likely duplicate of "Export button does nothing on Safari" — same code path as this ticket (src/export/download.ts:42).' },
      // identifier/title match baseSnapshot() in proposeCommentHandler —
      // CopilotProposalCard's TicketLine renders these, not ticketId.
      snapshot: {
        identifier: 'CW-138',
        title: cw138.title,
        evidence: 'src/export/download.ts:42',
        why: 'Same export code path. Linking rather than opening a second ticket.',
        agentName: 'Triage Agent',
        kindDisplay: 'Link duplicate',
      },
      status: 'proposed',
      expiresAt: hoursFromNow(24 - 0.3),
      createdAt: minutesAgo(18),
    },
    {
      id: 'prop-p3',
      origin: 'copilot',
      conversationId: 'conv-webhook-retry',
      anchorSeq: seqWebhook,
      agentId: 'agent-code-reviewer',
      projectId: 'proj-cw',
      kind: 'state_change',
      ticketId: cw141.id,
      payload: { stateId: CW_STATE_REVIEW },
      // Matches proposeStateChangeHandler's real snapshot shape —
      // fromStateName/fromStateColor/toStateName/toStateColor, not just ids.
      snapshot: {
        identifier: 'CW-141',
        title: cw141.title,
        fromStateId: CW_STATE_PROGRESS,
        fromStateName: 'In Progress',
        fromStateColor: '#c99a2e',
        toStateName: 'In Review',
        toStateColor: '#a86fe0',
        evidence: 'src/webhooks/retry.ts:120',
        why: 'Backoff and the 3-attempt cap are implemented and tested; the Stripe-client touch needs a human.',
        agentName: 'Code Reviewer',
      },
      status: 'proposed',
      expiresAt: hoursFromNow(23),
      createdAt: hoursAgo(1),
    },
    {
      id: 'prop-p3b',
      origin: 'copilot',
      conversationId: 'conv-webhook-retry',
      anchorSeq: seqWebhook,
      agentId: 'agent-code-reviewer',
      projectId: 'proj-cw',
      kind: 'assignee_change',
      ticketId: cw141.id,
      payload: { assigneeId: 'mem-2', action: 'add' },
      // Matches proposeAssigneeChangeHandler's real snapshot shape —
      // assigneeName/wasAssigned/currentAssigneeNames, not a bare id. CW-141
      // is currently assigned to the Code Reviewer agent (cwOverrides[141]).
      snapshot: {
        identifier: 'CW-141',
        title: cw141.title,
        assigneeName: 'Maya P.',
        wasAssigned: false,
        currentAssigneeNames: ['Code Reviewer'],
        why: 'Reassigning to Maya P. now that a human is needed for the Stripe-client touch.',
        agentName: 'Code Reviewer',
      },
      status: 'proposed',
      expiresAt: hoursFromNow(23),
      createdAt: hoursAgo(1),
    },
    {
      id: 'prop-p4',
      origin: 'copilot',
      conversationId: 'conv-token-refresh',
      anchorSeq: seqToken,
      agentId: 'agent-code-reviewer',
      projectId: 'proj-cw',
      kind: 'comment',
      ticketId: cw142.id,
      payload: { body: 'The write is not guarded — two tabs both pass the freshness check before either writes.' },
      snapshot: {
        identifier: 'CW-142',
        title: cw142.title,
        evidence: 'src/auth/session.ts:210',
        why: 'Disclosure prefix is added server-side; the comment will be marked as agent-authored.',
        agentName: 'Code Reviewer',
      },
      status: 'proposed',
      expiresAt: hoursFromNow(22),
      createdAt: hoursAgo(2),
    },
    {
      id: 'prop-p5',
      origin: 'copilot',
      conversationId: 'conv-pricing-claim',
      anchorSeq: seqPricing,
      agentId: 'agent-triage',
      projectId: 'proj-pl',
      sourceRequestId: 'req-pl-pricing-claim',
      kind: 'create_ticket',
      ticketId: null,
      payload: { projectId: 'proj-pl', title: 'Pricing page: "no per-seat AI" claim needs a source', stateId: PL_STATE.backlog, priority: 'low' },
      snapshot: {
        projectName: 'Product Launch',
        projectIdentifier: 'PL',
        stateName: 'Backlog',
        stateColor: '#9c9280',
        assigneeNames: [],
        why: 'Flagged from a request; no repo is linked to this project, so this is text-only reasoning.',
        agentName: 'Triage Agent',
      },
      status: 'proposed',
      expiresAt: hoursFromNow(20),
      createdAt: hoursAgo(4),
    },
    {
      id: 'prop-p6',
      origin: 'copilot',
      conversationId: 'conv-q3-retro',
      anchorSeq: seqQ3,
      agentId: 'agent-code-reviewer',
      projectId: 'proj-cw',
      kind: 'priority_change',
      ticketId: cw129.id,
      payload: { priority: 'urgent' },
      snapshot: {
        identifier: 'CW-129',
        title: cw129.title,
        fromPriority: 'low',
        evidence: 'WorkItemDetailPage.tsx:858',
        why: 'The comment box posts a raw textarea as bodyHtml and renders it with dangerouslySetInnerHTML.',
        agentName: 'Code Reviewer',
      },
      status: 'proposed',
      expiresAt: hoursFromNow(18),
      createdAt: hoursAgo(6),
    },
    // r2 — already approved (kind: add_label; no propose_add_label MCP tool
    // exists yet per proposals.service.ts's own comment, and executeProposal
    // has no case for it — so this is seeded pre-resolved, never replayed
    // through that path). ticket_labels already carries the 'ux' label on
    // CW-140 above, matching this proposal's real-world effect.
    {
      id: 'prop-r2',
      origin: 'copilot',
      conversationId: 'conv-safari-bug',
      anchorSeq: seqSafari,
      agentId: 'agent-triage',
      projectId: 'proj-cw',
      kind: 'add_label',
      ticketId: cw140.id,
      payload: { labelId: CW_LABEL('ux') },
      snapshot: {
        identifier: 'CW-140',
        title: cw140.title,
        labelName: 'ux',
        labelColor: '#2f7a4f',
        why: 'Matched the saved view it watches.',
        agentName: 'Triage Agent',
      },
      status: 'executed',
      decidedBy: 'user',
      decisionLatencyMs: 5200,
      expiresAt: hoursFromNow(4),
      createdAt: hoursAgo(20),
      resolvedAt: hoursAgo(19.5),
    },
    // r3 — already approved comment proposal; the resulting comment is
    // seeded for real below so the ticket and the proposal agree.
    {
      id: 'prop-r3',
      origin: 'copilot',
      conversationId: 'conv-q3-retro',
      anchorSeq: seqQ3,
      agentId: 'agent-code-reviewer',
      projectId: 'proj-cw',
      kind: 'comment',
      ticketId: cw133.id,
      payload: { body: 'Index build is O(n²) over labels.' },
      snapshot: {
        identifier: 'CW-133',
        title: cw133.title,
        why: 'Approved by you.',
        agentName: 'Code Reviewer',
      },
      status: 'executed',
      resultInfo: { commentId: 'cm-cw133-r3' },
      decidedBy: 'user',
      decisionLatencyMs: 3100,
      expiresAt: hoursFromNow(4),
      createdAt: hoursAgo(19),
      resolvedAt: hoursAgo(18.7),
    },
  ]);

  await tx.insert(schema.comments).values([
    {
      id: 'cm-cw133-r3',
      ticketId: cw133.id,
      authorId: 'mem-1',
      bodyHtml: buildAgentCommentHtml('Index build is O(n²) over labels.'),
      createdAt: hoursAgo(18.7),
    },
  ]);

  console.log(`Seeded ${wiSeeds.length} tickets across 2 projects.`);
  });
}

// Mirrors the self-disclosure prefix commentHtml.ts's buildCopilotCommentHtml
// applies to an approved Copilot-authored comment, without importing the
// services layer into the seed script.
function buildAgentCommentHtml(body: string): string {
  return `<p><em>Proposed by Code Reviewer, approved by Amaan Nawab</em></p><p>${body}</p>`;
}

// Only auto-run when executed directly (`npm run db:seed`) — importing this
// module from the dev-only /dev/reset route must not trigger a second run.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => {
      console.log('Seed complete.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
