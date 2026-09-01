import { describe, it, expect, vi, beforeEach } from 'vitest';

// Bare-handler tests against mocked services — the same split
// workItemTools.test.ts uses: handler logic here, real-protocol wiring in
// mcp.routes.test.ts. The db mock exists only because imported service
// modules construct a db client at import time (see copilot.routes.test.ts
// for the history).
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/workItems.service.js');
vi.mock('../services/comments.service.js');
vi.mock('../services/activity.service.js');
vi.mock('../services/states.service.js');
vi.mock('../services/members.service.js');
vi.mock('../services/projects.service.js');
vi.mock('../lib/actorNames.js');
vi.mock('../services/proposals.service.js', async (importOriginal) => {
  // createProposal is mocked; ProposalValidationError must stay REAL so the
  // handlers' instanceof check exercises the actual class.
  const actual = await importOriginal<typeof import('../services/proposals.service.js')>();
  return {
    ...actual,
    createProposal: vi.fn(),
  };
});

const workItemsService = await import('../services/workItems.service.js');
const statesService = await import('../services/states.service.js');
const projectsService = await import('../services/projects.service.js');
const proposalsService = await import('../services/proposals.service.js');
const { resolveActorNames } = await import('../lib/actorNames.js');
const {
  proposeCommentHandler,
  proposeStateChangeHandler,
  proposeAssigneeChangeHandler,
  proposePriorityChangeHandler,
  proposeCreateWorkItemHandler,
  listProjectsHandler,
} = await import('./proposalTools.js');

const CONV = 'conv-abc1234';

function workItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wi-1',
    projectId: 'proj-1',
    identifier: 'WI-1',
    title: 'A ticket',
    stateId: 'st-progress',
    priority: 'medium',
    isDraft: false,
    assigneeIds: [] as string[],
    updatedAt: new Date('2026-01-02T03:04:05.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(proposalsService.createProposal).mockResolvedValue({ id: 'prop-abc1234' } as never);
});

describe('conversation gating', () => {
  it('every propose handler refuses cleanly with no conversation id — read tools unaffected by design', async () => {
    const results = await Promise.all([
      proposeCommentHandler(null, { workItemId: 'wi-1', body: 'hi' }),
      proposeStateChangeHandler(null, { workItemId: 'wi-1', stateId: 'st-1' }),
      proposeAssigneeChangeHandler(null, { workItemId: 'wi-1', assigneeId: 'mem-2', action: 'add' }),
      proposePriorityChangeHandler(null, { workItemId: 'wi-1', priority: 'high' }),
      proposeCreateWorkItemHandler(null, { projectId: 'proj-1', title: 'x' }),
    ]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Proposals are unavailable in this session.');
    }
    // Refused before any fetch — the gate is the first thing checked.
    expect(workItemsService.getWorkItem).not.toHaveBeenCalled();
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });
});

describe('proposeCommentHandler', () => {
  it('treats a draft work item as not found, same as the read tools hide drafts', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem({ isDraft: true }) as never);

    const result = await proposeCommentHandler(CONV, { workItemId: 'wi-1', body: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('work item not found');
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('creates the proposal with the plain-text body and the display snapshot, returning the pending shape', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem() as never);

    const result = await proposeCommentHandler(CONV, { workItemId: 'wi-1', body: 'plain text' });

    expect(proposalsService.createProposal).toHaveBeenCalledWith({
      conversationId: CONV,
      kind: 'comment',
      workItemId: 'wi-1',
      payload: { body: 'plain text' },
      snapshot: { identifier: 'WI-1', title: 'A ticket', itemUpdatedAt: '2026-01-02T03:04:05.000Z' },
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      proposalId: 'prop-abc1234',
      status: 'pending_user_approval',
      summary: 'Proposed: comment on WI-1 — awaiting user approval',
    });
  });

  it("surfaces the cap's own ProposalValidationError message, not the generic scrub", async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem() as never);
    vi.mocked(proposalsService.createProposal).mockRejectedValue(
      new proposalsService.ProposalValidationError(
        'Too many proposals this turn (max 10) — ask the user to act on the pending ones first.',
      ),
    );

    const result = await proposeCommentHandler(CONV, { workItemId: 'wi-1', body: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many proposals this turn/);
  });

  it('rethrows a non-validation createProposal failure for withErrorSafetyNet to scrub', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem() as never);
    vi.mocked(proposalsService.createProposal).mockRejectedValue(new Error('pg exploded'));

    await expect(proposeCommentHandler(CONV, { workItemId: 'wi-1', body: 'hi' })).rejects.toThrow(
      'pg exploded',
    );
  });
});

describe('proposeStateChangeHandler', () => {
  it("rejects a stateId from a different project with a named validation error — the check updateWorkItem lacks", async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem() as never);
    vi.mocked(statesService.listStates).mockResolvedValue([
      { id: 'st-progress', name: 'In Progress', color: '#f2c94c' },
    ] as never);

    const result = await proposeStateChangeHandler(CONV, {
      workItemId: 'wi-1',
      stateId: 'st-other-project',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not belong to this ticket's project/);
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('rejects a no-op move to the state the ticket is already in', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem() as never);
    vi.mocked(statesService.listStates).mockResolvedValue([
      { id: 'st-progress', name: 'In Progress', color: '#f2c94c' },
    ] as never);

    const result = await proposeStateChangeHandler(CONV, { workItemId: 'wi-1', stateId: 'st-progress' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already in In Progress/);
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('snapshots from/to names AND colors — the card must render names, never ids', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem() as never);
    vi.mocked(statesService.listStates).mockResolvedValue([
      { id: 'st-progress', name: 'In Progress', color: '#f2c94c' },
      { id: 'st-done', name: 'Done', color: '#157a3d' },
    ] as never);

    const result = await proposeStateChangeHandler(CONV, { workItemId: 'wi-1', stateId: 'st-done' });

    expect(proposalsService.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'state_change',
        payload: { stateId: 'st-done' },
        snapshot: expect.objectContaining({
          fromStateId: 'st-progress',
          fromStateName: 'In Progress',
          fromStateColor: '#f2c94c',
          toStateName: 'Done',
          toStateColor: '#157a3d',
        }),
      }),
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.summary).toBe('Proposed: move WI-1 from In Progress to Done — awaiting user approval');
  });
});

describe('proposeAssigneeChangeHandler', () => {
  it('treats an unresolvable assignee as not found', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem() as never);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map());

    const result = await proposeAssigneeChangeHandler(CONV, {
      workItemId: 'wi-1',
      assigneeId: 'mem-ghost',
      action: 'add',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('assignee not found');
  });

  it('pre-checks direction: adding an already-assigned person is rejected at propose time', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(
      workItem({ assigneeIds: ['mem-2'] }) as never,
    );
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-2', 'Priya Sharma']]));

    const result = await proposeAssigneeChangeHandler(CONV, {
      workItemId: 'wi-1',
      assigneeId: 'mem-2',
      action: 'add',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Priya Sharma is already assigned to WI-1.');
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('pre-checks direction: removing someone not assigned is rejected at propose time', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem() as never);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-2', 'Priya Sharma']]));

    const result = await proposeAssigneeChangeHandler(CONV, {
      workItemId: 'wi-1',
      assigneeId: 'mem-2',
      action: 'remove',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Priya Sharma is not assigned to WI-1.');
  });

  it('snapshots the resolved name, wasAssigned, and the (empty) current-assignee context', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem() as never);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-2', 'Priya Sharma']]));

    await proposeAssigneeChangeHandler(CONV, { workItemId: 'wi-1', assigneeId: 'mem-2', action: 'add' });

    expect(proposalsService.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'assignee_change',
        payload: { assigneeId: 'mem-2', action: 'add' },
        snapshot: expect.objectContaining({
          assigneeName: 'Priya Sharma',
          wasAssigned: false,
          currentAssigneeNames: [],
        }),
      }),
    );
  });

  // Regression test (QA finding): the card's context line previously showed
  // only the PROPOSED person's own wasAssigned flag, which read as if it
  // described the whole ticket — "currently unassigned" on a ticket that
  // had a different assignee. The snapshot now carries the ticket's actual
  // current assignees, resolved to names at propose time.
  it('snapshots the ticket\'s current assignees as resolved names, not ids', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(
      workItem({ assigneeIds: ['mem-4'] }) as never,
    );
    vi.mocked(resolveActorNames).mockResolvedValue(
      new Map([
        ['mem-2', 'Priya Sharma'],
        ['mem-4', 'Lena Park'],
      ]),
    );

    await proposeAssigneeChangeHandler(CONV, { workItemId: 'wi-1', assigneeId: 'mem-2', action: 'add' });

    expect(resolveActorNames).toHaveBeenCalledWith(['mem-2', 'mem-4']);
    expect(proposalsService.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({ currentAssigneeNames: ['Lena Park'] }),
      }),
    );
  });
});

describe('proposePriorityChangeHandler', () => {
  it('rejects a no-op priority proposal', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem({ priority: 'high' }) as never);

    const result = await proposePriorityChangeHandler(CONV, { workItemId: 'wi-1', priority: 'high' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already high/);
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('snapshots fromPriority for the from→to chips', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(workItem({ priority: 'medium' }) as never);

    await proposePriorityChangeHandler(CONV, { workItemId: 'wi-1', priority: 'urgent' });

    expect(proposalsService.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { priority: 'urgent' },
        snapshot: expect.objectContaining({ fromPriority: 'medium' }),
      }),
    );
  });
});

describe('proposeCreateWorkItemHandler', () => {
  const STATES = [
    // Deliberately unsorted-looking groups: listStates returns board order
    // (sortOrder asc), so the FIRST backlog/unstarted entry in the returned
    // array is the default — Triage (group 'triage') must be skipped.
    { id: 'st-triage', name: 'Triage', color: '#6b6050', group: 'triage' },
    { id: 'st-backlog', name: 'Backlog', color: '#9c9280', group: 'backlog' },
    { id: 'st-todo', name: 'Todo', color: '#7d8a9c', group: 'unstarted' },
    { id: 'st-done', name: 'Done', color: '#157a3d', group: 'completed' },
  ];

  it('404s a missing project', async () => {
    vi.mocked(projectsService.getProject).mockResolvedValue(undefined as never);

    const result = await proposeCreateWorkItemHandler(CONV, { projectId: 'proj-x', title: 'New' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('project not found');
  });

  it('defaults stateId to the first backlog/unstarted state in board order when omitted', async () => {
    vi.mocked(projectsService.getProject).mockResolvedValue(
      { id: 'proj-1', name: 'Launch', identifier: 'LAUNCH' } as never,
    );
    vi.mocked(statesService.listStates).mockResolvedValue(STATES as never);

    await proposeCreateWorkItemHandler(CONV, { projectId: 'proj-1', title: 'New ticket' });

    expect(proposalsService.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create_work_item',
        workItemId: null,
        payload: expect.objectContaining({ stateId: 'st-backlog' }),
        snapshot: expect.objectContaining({
          projectName: 'Launch',
          projectIdentifier: 'LAUNCH',
          stateName: 'Backlog',
          stateColor: '#9c9280',
          assigneeNames: [],
        }),
      }),
    );
  });

  it('errors when the project has no backlog/unstarted state and none was given', async () => {
    vi.mocked(projectsService.getProject).mockResolvedValue({ id: 'proj-1', name: 'P', identifier: 'P' } as never);
    vi.mocked(statesService.listStates).mockResolvedValue(
      [{ id: 'st-done', name: 'Done', color: '#157a3d', group: 'completed' }] as never,
    );

    const result = await proposeCreateWorkItemHandler(CONV, { projectId: 'proj-1', title: 'New' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no backlog or unstarted state/);
  });

  it("rejects an explicit stateId that isn't one of the project's states", async () => {
    vi.mocked(projectsService.getProject).mockResolvedValue({ id: 'proj-1', name: 'P', identifier: 'P' } as never);
    vi.mocked(statesService.listStates).mockResolvedValue(STATES as never);

    const result = await proposeCreateWorkItemHandler(CONV, {
      projectId: 'proj-1',
      title: 'New',
      stateId: 'st-foreign',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not belong to this project/);
  });

  it('rejects unresolvable assignee ids by name, resolving the rest into the snapshot otherwise', async () => {
    vi.mocked(projectsService.getProject).mockResolvedValue({ id: 'proj-1', name: 'P', identifier: 'P' } as never);
    vi.mocked(statesService.listStates).mockResolvedValue(STATES as never);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-2', 'Priya Sharma']]));

    const bad = await proposeCreateWorkItemHandler(CONV, {
      projectId: 'proj-1',
      title: 'New',
      assigneeIds: ['mem-2', 'mem-ghost'],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/unknown assignee id\(s\): mem-ghost/);

    await proposeCreateWorkItemHandler(CONV, {
      projectId: 'proj-1',
      title: 'New',
      assigneeIds: ['mem-2'],
    });
    expect(proposalsService.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ assigneeIds: ['mem-2'] }),
        snapshot: expect.objectContaining({ assigneeNames: ['Priya Sharma'] }),
      }),
    );
  });
});

describe('listProjectsHandler', () => {
  it('projects rows down to id/name/identifier only — no config noise in the model context', async () => {
    vi.mocked(projectsService.listProjects).mockResolvedValue([
      {
        id: 'proj-1',
        name: 'Launch',
        identifier: 'LAUNCH',
        automations: { huge: 'blob' },
        coverGradient: ['#000', '#fff'],
        memberIds: ['mem-1'],
      },
    ] as never);

    const result = await listProjectsHandler();

    expect(JSON.parse(result.content[0].text)).toEqual([
      { id: 'proj-1', name: 'Launch', identifier: 'LAUNCH' },
    ]);
  });
});
