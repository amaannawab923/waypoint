// Ported from waypoint-electron/src/renderer/mock/seed.ts — same ids, same
// demo dataset, just inserted via Drizzle instead of held in a JS object.
// Array-of-id fields (memberIds, assigneeIds, labelIds, scopeProjectIds) are
// expanded into their join-table rows here instead of staying inline.
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
    createdAt: daysAgo(120),
    restrictWorkspaceCreation: false,
  });

  await tx.insert(schema.members).values([
    {
      id: 'mem-1',
      workspaceId: 'ws-1',
      fullName: 'Amaan Nawab',
      displayName: 'Amaan',
      email: 'amaan@waypointlabs.dev',
      avatarColor: '#c2542a',
      role: 'admin',
      authMethod: 'email',
      joinedAt: daysAgo(120),
    },
    {
      id: 'mem-2',
      workspaceId: 'ws-1',
      fullName: 'Priya Raman',
      displayName: 'Priya',
      email: 'priya@waypointlabs.dev',
      avatarColor: '#2f6fa8',
      role: 'admin',
      authMethod: 'google',
      joinedAt: daysAgo(110),
    },
    {
      id: 'mem-3',
      workspaceId: 'ws-1',
      fullName: 'Devon Clarke',
      displayName: 'Devon',
      email: 'devon@waypointlabs.dev',
      avatarColor: '#2f7a4f',
      role: 'member',
      authMethod: 'github',
      joinedAt: daysAgo(95),
    },
    {
      id: 'mem-4',
      workspaceId: 'ws-1',
      fullName: 'Lena Ostrowski',
      displayName: 'Lena',
      email: 'lena@waypointlabs.dev',
      avatarColor: '#a5780c',
      role: 'member',
      authMethod: 'email',
      joinedAt: daysAgo(60),
    },
    {
      id: 'mem-5',
      workspaceId: 'ws-1',
      fullName: 'Marcus Webb',
      displayName: 'Marcus',
      email: 'marcus@waypointlabs.dev',
      avatarColor: '#8a3719',
      role: 'guest',
      authMethod: 'email',
      joinedAt: daysAgo(14),
    },
  ]);

  await tx.insert(schema.projects).values([
    {
      id: 'proj-launch',
      workspaceId: 'ws-1',
      name: 'Product Launch',
      identifier: 'LAUNCH',
      description:
        'Everything needed to ship the v1 public launch — marketing site, onboarding, and the first release train.',
      icon: '🚀',
      coverGradientStart: '#c2542a',
      coverGradientEnd: '#3a2314',
      visibility: 'public',
      leadId: 'mem-1',
      defaultAssigneeId: 'mem-1',
      timezone: 'UTC',
      estimate: { type: 'points', values: ['0', '1', '2', '3', '5', '8', '13', '21'] },
      automations: {
        autoArchiveEnabled: false,
        autoArchiveAfterDays: 30,
        autoCloseEnabled: false,
        autoCloseAfterDays: 30,
      },
      createdAt: daysAgo(90),
      archivedAt: null,
      guestAccessEnabled: false,
      // Seeded requests below (in-1, in-2, ...) come from external beta
      // users — the public form is on for this project.
      acceptsRequests: true,
    },
    {
      id: 'proj-tools',
      workspaceId: 'ws-1',
      name: 'Internal Tools',
      identifier: 'TOOLS',
      description: 'Internal dashboards and scripts the team relies on day to day.',
      icon: '🛠️',
      coverGradientStart: '#2f6fa8',
      coverGradientEnd: '#17293c',
      visibility: 'private',
      leadId: 'mem-2',
      defaultAssigneeId: null,
      timezone: 'UTC',
      estimate: null,
      automations: {
        autoArchiveEnabled: false,
        autoArchiveAfterDays: 30,
        autoCloseEnabled: false,
        autoCloseAfterDays: 30,
      },
      createdAt: daysAgo(45),
      archivedAt: null,
      guestAccessEnabled: false,
    },
  ]);

  await tx.insert(schema.projectMembers).values([
    ...['mem-1', 'mem-2', 'mem-3', 'mem-4'].map((memberId) => ({ projectId: 'proj-launch', memberId })),
    ...['mem-1', 'mem-2', 'mem-5'].map((memberId) => ({ projectId: 'proj-tools', memberId })),
  ]);

  function statesFor(projectId: string) {
    const p = projectId === 'proj-launch' ? 'l' : 't';
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
  await tx.insert(schema.ticketStates).values([...statesFor('proj-launch'), ...statesFor('proj-tools')]);

  await tx.insert(schema.labels).values([
    { id: 'lbl-1', projectId: 'proj-launch', name: 'bug', color: '#b7332a' },
    { id: 'lbl-2', projectId: 'proj-launch', name: 'design', color: '#a86fe0' },
    { id: 'lbl-3', projectId: 'proj-launch', name: 'marketing', color: '#c99a2e' },
    { id: 'lbl-4', projectId: 'proj-launch', name: 'infra', color: '#2f6fa8' },
    { id: 'lbl-5', projectId: 'proj-tools', name: 'chore', color: '#9c9280' },
    { id: 'lbl-6', projectId: 'proj-tools', name: 'bug', color: '#b7332a' },
  ]);

  await tx.insert(schema.workstreams).values([
    {
      id: 'mod-1',
      projectId: 'proj-launch',
      name: 'Marketing Site',
      description: 'Public-facing site, pricing page, and waitlist capture.',
      leadId: 'mem-4',
      status: 'active',
      startDate: dateOnly(daysAgo(20)),
      targetDate: dateOnly(daysFromNow(10)),
    },
    {
      id: 'mod-2',
      projectId: 'proj-launch',
      name: 'Onboarding Flow',
      description: 'First-run experience from signup to first created ticket.',
      leadId: 'mem-3',
      status: 'planned',
      startDate: dateOnly(daysFromNow(2)),
      targetDate: dateOnly(daysFromNow(21)),
    },
    {
      id: 'mod-3',
      projectId: 'proj-launch',
      name: 'Release Infrastructure',
      description: 'CI/CD, changelog automation, and rollback tooling for the launch train.',
      leadId: 'mem-1',
      status: 'active',
      startDate: dateOnly(daysAgo(30)),
      targetDate: dateOnly(daysFromNow(5)),
    },
  ]);

  await tx.insert(schema.workstreamMembers).values([
    { workstreamId: 'mod-1', memberId: 'mem-4' },
    { workstreamId: 'mod-1', memberId: 'mem-2' },
    { workstreamId: 'mod-2', memberId: 'mem-3' },
    { workstreamId: 'mod-3', memberId: 'mem-1' },
    { workstreamId: 'mod-3', memberId: 'mem-3' },
  ]);

  await tx.insert(schema.sprints).values([
    {
      id: 'cyc-1',
      projectId: 'proj-launch',
      name: 'Sprint 4 — Launch Week',
      description: 'Final push before the public announcement.',
      startDate: dateOnly(daysAgo(3)),
      endDate: dateOnly(daysFromNow(11)),
    },
    {
      id: 'cyc-2',
      projectId: 'proj-launch',
      name: 'Sprint 5 — Post-launch Hardening',
      description: 'Bug fixes and polish once real users are in.',
      startDate: dateOnly(daysFromNow(12)),
      endDate: dateOnly(daysFromNow(26)),
    },
    {
      id: 'cyc-0',
      projectId: 'proj-launch',
      name: 'Sprint 3 — Beta Feedback',
      description: 'Closed beta feedback, reviewed and sorted.',
      startDate: dateOnly(daysAgo(17)),
      endDate: dateOnly(daysAgo(4)),
    },
  ]);

  // --- Tickets -----------------------------------------------------
  type WiSeed = {
    id: string;
    projectId: string;
    title: string;
    stateId: string;
    priority: (typeof schema.priorityEnum.enumValues)[number];
    source?: (typeof schema.ticketSourceEnum.enumValues)[number];
    assigneeIds?: string[];
    labelIds?: string[];
    workstreamId?: string | null;
    sprintId?: string | null;
    parentId?: string | null;
    dueDate?: Date | null;
    estimatePoints?: number | null;
    createdAt?: Date;
    updatedAt?: Date;
  };

  const L = {
    backlog: 'st-l-backlog',
    todo: 'st-l-todo',
    progress: 'st-l-progress',
    review: 'st-l-review',
    done: 'st-l-done',
    cancelled: 'st-l-cancelled',
  };
  const T = {
    backlog: 'st-t-backlog',
    todo: 'st-t-todo',
    progress: 'st-t-progress',
    done: 'st-t-done',
  };

  let seq = 0;
  const wiSeeds: WiSeed[] = [];
  function wi(projectId: string, title: string, opts: Omit<WiSeed, 'id' | 'projectId' | 'title'>): WiSeed {
    seq += 1;
    const s: WiSeed = { id: `wi-${seq}`, projectId, title, ...opts };
    wiSeeds.push(s);
    return s;
  }

  wi('proj-launch', 'Design pricing page hero section', {
    stateId: L.done,
    priority: 'high',
    assigneeIds: ['mem-4'],
    labelIds: ['lbl-2', 'lbl-3'],
    workstreamId: 'mod-1',
    sprintId: 'cyc-0',
    estimatePoints: 3,
  });
  wi('proj-launch', 'Set up waitlist capture form + email confirmation', {
    stateId: L.done,
    priority: 'high',
    assigneeIds: ['mem-3'],
    labelIds: ['lbl-3'],
    workstreamId: 'mod-1',
    sprintId: 'cyc-0',
    estimatePoints: 2,
  });
  const navBreaks = wi('proj-launch', 'Responsive nav breaks on iPad landscape', {
    stateId: L.progress,
    priority: 'urgent',
    assigneeIds: ['mem-4', 'agent-claude'],
    labelIds: ['lbl-1', 'lbl-2'],
    workstreamId: 'mod-1',
    sprintId: 'cyc-1',
    dueDate: daysFromNow(2),
    estimatePoints: 1,
  });
  wi('proj-launch', 'Write launch day announcement copy', {
    stateId: L.review,
    priority: 'high',
    assigneeIds: ['mem-2'],
    labelIds: ['lbl-3'],
    sprintId: 'cyc-1',
    dueDate: daysFromNow(4),
  });
  wi('proj-launch', 'Wire onboarding checklist to first-run state', {
    stateId: L.todo,
    priority: 'medium',
    assigneeIds: ['mem-3'],
    workstreamId: 'mod-2',
    sprintId: 'cyc-1',
    estimatePoints: 5,
  });
  wi('proj-launch', 'Draft empty states for onboarding steps 1-4', {
    stateId: L.todo,
    priority: 'medium',
    assigneeIds: ['mem-4'],
    workstreamId: 'mod-2',
    labelIds: ['lbl-2'],
  });
  const pipeline = wi('proj-launch', 'Set up staging → production promotion pipeline', {
    stateId: L.progress,
    priority: 'urgent',
    assigneeIds: ['mem-1', 'agent-codex'],
    labelIds: ['lbl-4'],
    workstreamId: 'mod-3',
    sprintId: 'cyc-1',
    dueDate: daysFromNow(1),
    estimatePoints: 8,
  });
  const changelog = wi('proj-launch', 'Add automated changelog generation from PR titles', {
    stateId: L.backlog,
    priority: 'low',
    assigneeIds: ['agent-release-notes'],
    labelIds: ['lbl-4'],
    workstreamId: 'mod-3',
  });
  wi('proj-launch', 'Rollback script fails silently on partial deploy', {
    stateId: L.backlog,
    priority: 'high',
    labelIds: ['lbl-1', 'lbl-4'],
    workstreamId: 'mod-3',
  });
  const selfServe = wi('proj-launch', 'Evaluate self-serve trial vs. waitlist-only launch', {
    stateId: L.backlog,
    priority: 'medium',
    source: 'request',
  });
  wi('proj-launch', 'Old pricing experiment branch — abandoned', {
    stateId: L.cancelled,
    priority: 'none',
    labelIds: ['lbl-3'],
  });
  wi('proj-launch', 'Spike: server-sent events for live activity feed', {
    stateId: L.backlog,
    priority: 'low',
    labelIds: ['lbl-4'],
  });
  wi('proj-tools', 'Internal admin: add bulk member CSV import', {
    stateId: T.todo,
    priority: 'medium',
    assigneeIds: ['mem-2'],
    labelIds: ['lbl-5'],
  });
  wi('proj-tools', 'Nightly usage report cron silently fails on holidays', {
    stateId: T.progress,
    priority: 'high',
    assigneeIds: ['mem-1'],
    labelIds: ['lbl-6'],
    dueDate: daysFromNow(3),
  });
  const darkMode = wi('proj-tools', 'Add dark-mode toggle to internal status page', {
    stateId: T.done,
    priority: 'low',
    assigneeIds: ['mem-5', 'agent-gemini'],
  });
  wi('proj-tools', 'Audit unused feature flags', { stateId: T.backlog, priority: 'none', labelIds: ['lbl-5'] });
  wi('proj-tools', 'Migrate internal scripts off deprecated API', {
    stateId: T.backlog,
    priority: 'medium',
    labelIds: ['lbl-5'],
  });
  wi('proj-launch', 'Fix nav overlap on 1024px breakpoint specifically', {
    stateId: L.progress,
    priority: 'high',
    assigneeIds: ['mem-4'],
    parentId: navBreaks.id,
    sprintId: 'cyc-1',
  });
  wi('proj-launch', 'Add Playwright regression test for tablet nav', {
    stateId: L.todo,
    priority: 'medium',
    parentId: navBreaks.id,
    sprintId: 'cyc-1',
  });

  // Resolve each item's createdAt/updatedAt once, up front, so the ticket
  // row and its 'created' activity entry below agree on the same timestamp
  // instead of each independently rolling their own random date.
  for (const w of wiSeeds) {
    w.createdAt = w.createdAt ?? daysAgo(Math.floor(Math.random() * 14) + 1);
    w.updatedAt = w.updatedAt ?? daysAgo(Math.floor(Math.random() * 3));
  }

  const prefixFor = (projectId: string) => (projectId === 'proj-launch' ? 'LAUNCH' : 'TOOLS');
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
        stateId: w.stateId,
        priority: w.priority,
        source: w.source ?? 'manual',
        workstreamId: w.workstreamId ?? null,
        sprintId: w.sprintId ?? null,
        parentId: w.parentId ?? null,
        estimatePoints: w.estimatePoints != null ? String(w.estimatePoints) : null,
        estimateValue: w.estimatePoints != null ? String(w.estimatePoints) : null,
        dueDate: w.dueDate ? dateOnly(w.dueDate) : null,
        createdById: 'mem-1',
        createdAt: w.createdAt!,
        updatedAt: w.updatedAt!,
        isDraft: false,
        sortOrder: String(i * 1000),
      };
    }),
  );

  const labelRows = wiSeeds.flatMap((w) => (w.labelIds ?? []).map((labelId) => ({ ticketId: w.id, labelId })));
  if (labelRows.length) await tx.insert(schema.ticketLabels).values(labelRows);

  const assigneeRows = wiSeeds.flatMap((w) =>
    (w.assigneeIds ?? []).map((assigneeId) => ({
      ticketId: w.id,
      assigneeId,
      assigneeKind: (assigneeId.startsWith('agent-') ? 'agent' : 'member') as 'agent' | 'member',
    })),
  );
  if (assigneeRows.length) await tx.insert(schema.ticketAssignees).values(assigneeRows);

  // --- Agents -----------------------------------------------------------
  await tx.insert(schema.agents).values([
    {
      id: 'agent-claude',
      workspaceId: 'ws-1',
      name: 'Ethan',
      avatarColor: '#4f5cdb',
      instructionsFilename: 'ethan.md',
      instructionsContentMarkdown:
        '# Ethan\n\nGeneral-purpose coding agent. Follow the existing code style. Open a PR when done; never merge automatically.',
      scopeAllProjects: true,
      executionMethod: 'local-claude-subscription',
      model: 'Claude Opus',
      autonomy: 'full-auto',
      triggers: ['on-assign'],
      isActive: true,
      createdById: CURRENT_USER_ID,
      createdAt: daysAgo(60),
      updatedAt: daysAgo(60),
    },
    {
      id: 'agent-codex',
      workspaceId: 'ws-1',
      name: 'Dan',
      avatarColor: '#3a3a3a',
      instructionsFilename: 'dan.md',
      instructionsContentMarkdown:
        '# Dan\n\nRuns and validates the staging → production promotion pipeline. Prefers small, reviewable diffs. Asks before opening a PR.',
      scopeAllProjects: false,
      executionMethod: 'local-claude-subscription',
      model: 'Claude Sonnet',
      autonomy: 'ask-before-pr',
      triggers: ['on-assign'],
      isActive: true,
      createdById: CURRENT_USER_ID,
      createdAt: daysAgo(45),
      updatedAt: daysAgo(45),
    },
    {
      id: 'agent-gemini',
      workspaceId: 'ws-1',
      name: 'Alice',
      avatarColor: '#e0a233',
      instructionsFilename: 'alice.md',
      instructionsContentMarkdown:
        '# Alice\n\nReproduces reported bugs before proposing a fix. Describes the root cause, then opens a PR.',
      scopeAllProjects: false,
      executionMethod: 'local-claude-subscription',
      model: 'Claude Haiku',
      autonomy: 'full-auto',
      triggers: ['on-assign'],
      isActive: true,
      createdById: CURRENT_USER_ID,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(2),
    },
    {
      id: 'agent-release-notes',
      workspaceId: 'ws-1',
      name: 'Sam',
      avatarColor: '#7a5cd6',
      instructionsFilename: 'sam.md',
      instructionsContentMarkdown:
        '# Sam\n\nSummarizes merged PRs into a changelog entry whenever the "release" label is added. Keeps entries to one line, written for users.',
      scopeAllProjects: false,
      executionMethod: 'local-claude-subscription',
      model: 'Claude Sonnet',
      autonomy: 'ask-before-write',
      triggers: ['on-label'],
      templateId: 'release-notes-writer',
      isActive: true,
      createdById: CURRENT_USER_ID,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(1),
    },
  ]);

  await tx.insert(schema.agentProjectScopes).values([
    { agentId: 'agent-codex', projectId: 'proj-launch' },
    { agentId: 'agent-gemini', projectId: 'proj-tools' },
    { agentId: 'agent-release-notes', projectId: 'proj-launch' },
  ]);

  await tx.insert(schema.agentAssignments).values([
    {
      id: 'aa-1',
      ticketId: navBreaks.id,
      agentId: 'agent-claude',
      status: 'needs-review',
      summary: 'Opened PR #123 — adds a min-width guard to the flex container.',
      startedAt: daysAgo(1),
      updatedAt: daysAgo(0),
    },
    {
      id: 'aa-2',
      ticketId: pipeline.id,
      agentId: 'agent-codex',
      status: 'running',
      summary: 'Running the staging → production promotion pipeline.',
      startedAt: daysAgo(0),
      updatedAt: daysAgo(0),
    },
    {
      id: 'aa-3',
      ticketId: changelog.id,
      agentId: 'agent-release-notes',
      status: 'blocked',
      summary: 'Blocked — needs the target CI provider confirmed before continuing.',
      startedAt: daysAgo(2),
      updatedAt: daysAgo(1),
    },
    {
      id: 'aa-4',
      ticketId: darkMode.id,
      agentId: 'agent-gemini',
      status: 'done',
      summary: 'Opened PR #58 to special-case public holidays — merged and deployed.',
      startedAt: daysAgo(3),
      updatedAt: daysAgo(2),
    },
  ]);

  await tx.insert(schema.comments).values([
    {
      id: 'cm-1',
      ticketId: navBreaks.id,
      authorId: 'mem-2',
      bodyHtml: '<p>Repro on iPad Air (1024×768) in Safari — the nav items wrap under the logo.</p>',
      createdAt: daysAgo(1),
    },
    {
      id: 'cm-2',
      ticketId: navBreaks.id,
      authorId: 'mem-4',
      bodyHtml: '<p>Found it — the flex container is missing a min-width guard. Fix incoming.</p>',
      createdAt: daysAgo(0),
    },
    {
      id: 'cm-3',
      ticketId: pipeline.id,
      authorId: 'mem-1',
      bodyHtml: '<p>Pipeline works end to end in staging. Doing one more dry run before I mark this done.</p>',
      createdAt: daysAgo(0),
    },
  ]);

  // --- Activity -----------------------------------------------------------
  function activityFor(w: WiSeed, createdAt: Date) {
    const entries: (typeof schema.activityEntries.$inferInsert)[] = [
      {
        id: `act-${w.id}-created`,
        ticketId: w.id,
        actorId: 'mem-1',
        verb: 'created',
        detail: 'created the ticket',
        createdAt,
      },
    ];
    if (w.priority !== 'none') {
      entries.push({
        id: `act-${w.id}-priority`,
        ticketId: w.id,
        actorId: 'mem-1',
        verb: 'priority_changed',
        detail: `set priority to ${w.priority}`,
        createdAt,
      });
    }
    if ((w.assigneeIds ?? []).length > 0) {
      entries.push({
        id: `act-${w.id}-assignee`,
        ticketId: w.id,
        actorId: 'mem-1',
        verb: 'assignee_added',
        detail: 'added an assignee',
        createdAt,
      });
    }
    return entries;
  }
  const baseActivity = wiSeeds.flatMap((w) => activityFor(w, w.createdAt!));
  const agentActivity: (typeof schema.activityEntries.$inferInsert)[] = [
    {
      id: 'act-agent-1a',
      ticketId: navBreaks.id,
      actorId: CURRENT_USER_ID,
      verb: 'agent_assigned',
      detail: 'assigned Ethan (agent) to this ticket',
      createdAt: daysAgo(1),
    },
    {
      id: 'act-agent-1b',
      ticketId: navBreaks.id,
      actorId: 'agent-claude',
      verb: 'agent_status_changed',
      detail: 'opened PR #123 and marked this needs review',
      createdAt: daysAgo(0),
    },
    {
      id: 'act-agent-2a',
      ticketId: pipeline.id,
      actorId: CURRENT_USER_ID,
      verb: 'agent_assigned',
      detail: 'assigned Dan (agent) to this ticket',
      createdAt: daysAgo(1),
    },
    {
      id: 'act-agent-2b',
      ticketId: pipeline.id,
      actorId: 'agent-codex',
      verb: 'agent_status_changed',
      detail: 'started running the staging promotion pipeline',
      createdAt: daysAgo(0),
    },
  ];
  await tx.insert(schema.activityEntries).values([...baseActivity, ...agentActivity]);

  await tx.insert(schema.docs).values([
    {
      id: 'pg-1',
      projectId: 'proj-launch',
      title: 'Launch Runbook',
      icon: '🧭',
      contentHtml: `<h2>Launch Day Runbook</h2><p>Step-by-step for the public launch. Keep this updated as the plan changes.</p>`,
      visibility: 'public',
      ownerId: 'mem-1',
      isFavorite: true,
      isLocked: false,
      parentDocId: null,
      createdAt: daysAgo(25),
      updatedAt: daysAgo(1),
    },
    {
      id: 'pg-2',
      projectId: 'proj-launch',
      title: 'Positioning Notes',
      icon: '🎯',
      contentHtml: `<h2>Positioning</h2><p>Working notes on how we talk about the product before the copy gets finalized.</p>`,
      visibility: 'private',
      ownerId: 'mem-2',
      isFavorite: false,
      isLocked: false,
      parentDocId: null,
      createdAt: daysAgo(18),
      updatedAt: daysAgo(3),
    },
    {
      id: 'pg-3',
      projectId: 'proj-tools',
      title: 'Internal Scripts Index',
      icon: '📇',
      contentHtml: `<h2>Scripts</h2><p>Index of internal one-off scripts and what they do. Keep alphabetized.</p>`,
      visibility: 'private',
      ownerId: 'mem-2',
      isFavorite: false,
      isLocked: false,
      parentDocId: null,
      createdAt: daysAgo(40),
      updatedAt: daysAgo(10),
    },
  ]);

  await tx.insert(schema.savedViews).values([
    {
      id: 'view-1',
      projectId: 'proj-launch',
      name: 'My urgent items',
      ownerId: 'mem-1',
      filters: { priority: ['urgent'], assignee: 'me' },
      visibility: 'private',
      isFavorite: true,
      updatedAt: daysAgo(2),
    },
    {
      id: 'view-2',
      projectId: 'proj-launch',
      name: 'This sprint, no assignee',
      ownerId: 'mem-2',
      filters: { sprintId: 'cyc-1', assignee: 'none' },
      visibility: 'public',
      isFavorite: false,
      updatedAt: daysAgo(5),
    },
  ]);

  await tx.insert(schema.requests).values([
    {
      id: 'in-1',
      projectId: 'proj-launch',
      title: 'Dark mode toggle disappears on mobile Safari',
      description: 'Reported by a beta user — the toggle in settings is unreachable on iOS Safari.',
      status: 'pending',
      sourceName: 'Beta user (external)',
      sourceEmail: 'user@example.com',
      createdAt: daysAgo(1),
      linkedTicketId: null,
    },
    {
      id: 'in-2',
      projectId: 'proj-launch',
      title: 'Would love a CSV export for reports',
      description: 'Came up twice in beta feedback calls this week.',
      status: 'accepted',
      sourceName: 'Beta user (external)',
      sourceEmail: 'other@example.com',
      createdAt: daysAgo(6),
      linkedTicketId: selfServe.id,
    },
    {
      id: 'in-3',
      projectId: 'proj-launch',
      title: 'Typo on pricing page: "recieve"',
      description: '',
      status: 'declined',
      sourceName: 'Anonymous',
      sourceEmail: '',
      createdAt: daysAgo(8),
      linkedTicketId: null,
    },
  ]);

  await tx.insert(schema.scratchNotes).values([
    {
      id: 'sk-1',
      authorId: CURRENT_USER_ID,
      title: 'Ask Devon about DNS cutover window',
      body: 'Needs at least 48h notice before launch day.',
      color: '#c99a2e',
      updatedAt: daysAgo(2),
    },
    {
      id: 'sk-2',
      authorId: CURRENT_USER_ID,
      title: 'Demo script for investor call',
      body: 'Walk through: create project → board → sprint burndown → doc.',
      color: '#2f6fa8',
      updatedAt: daysAgo(5),
    },
  ]);

  await tx.insert(schema.notifications).values([
    {
      id: 'nt-1',
      recipientId: CURRENT_USER_ID,
      actorId: 'mem-2',
      ticketId: navBreaks.id,
      message: 'mentioned you on "Responsive nav breaks on iPad landscape"',
      read: false,
      kind: 'mention',
      createdAt: daysAgo(0),
    },
    {
      id: 'nt-2',
      recipientId: CURRENT_USER_ID,
      actorId: 'mem-4',
      ticketId: navBreaks.id,
      message: 'commented on "Responsive nav breaks on iPad landscape"',
      read: false,
      kind: 'comment',
      createdAt: daysAgo(0),
    },
    {
      id: 'nt-4',
      recipientId: CURRENT_USER_ID,
      actorId: 'agent-claude',
      ticketId: navBreaks.id,
      message: 'needs your input on "Responsive nav breaks on iPad landscape"',
      read: false,
      kind: 'agent_needs_review',
      createdAt: daysAgo(0),
    },
  ]);

  console.log(`Seeded ${wiSeeds.length} tickets across 2 projects.`);
  });
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
