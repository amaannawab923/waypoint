import { describe, it, expect, vi, beforeEach } from 'vitest';

// Bare-handler tests against mocked services — the same split
// ticketTools.test.ts uses: handler logic here, real-protocol wiring in
// mcp.routes.test.ts. The db mock exists only because imported service
// modules construct a db client at import time (see copilot.routes.test.ts
// for the history).
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/tickets.service.js');
vi.mock('../services/comments.service.js');
vi.mock('../services/activity.service.js');
vi.mock('../services/states.service.js');
vi.mock('../services/members.service.js');
vi.mock('../services/projects.service.js');
vi.mock('../lib/actorNames.js');
// The comment and state-change handlers now resolve their target through the
// provider seam (a "tref-" id can name a Jira issue), so the native branch
// goes through nativeProvider.getByRef — which is also what already carries
// the draft gate. The three native-only kinds still call ticketsService
// directly and are mocked as before.
vi.mock('../providers/native.js');
vi.mock('../services/proposals.service.js', async (importOriginal) => {
  // createProposal is mocked; ProposalValidationError must stay REAL so the
  // handlers' instanceof check exercises the actual class.
  const actual = await importOriginal<typeof import('../services/proposals.service.js')>();
  return {
    ...actual,
    createProposal: vi.fn(),
  };
});

const ticketsService = await import('../services/tickets.service.js');
const statesService = await import('../services/states.service.js');
const projectsService = await import('../services/projects.service.js');
const proposalsService = await import('../services/proposals.service.js');
const { resolveActorNames } = await import('../lib/actorNames.js');
const { nativeProvider } = await import('../providers/native.js');
const {
  proposeCommentHandler,
  proposeStateChangeHandler,
  proposeAssigneeChangeHandler,
  proposePriorityChangeHandler,
  proposeCreateTicketHandler,
  listProjectsHandler,
} = await import('./proposalTools.js');

const CONV = 'conv-abc1234';

function ticket(overrides: Record<string, unknown> = {}) {
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

/** The same ticket, as the provider seam hands it back. `detail` is the raw
 *  row spread through (see providers/native.ts), which is where the snapshot's
 *  itemUpdatedAt comes from. */
function normalized(overrides: Record<string, unknown> = {}) {
  const item = ticket(overrides);
  return {
    provider: 'native' as const,
    ref: item.id,
    identifier: item.identifier,
    title: item.title,
    projectId: item.projectId,
    stateId: item.stateId,
    stateName: 'In Progress',
    stateGroup: 'started',
    priority: item.priority,
    dueDate: null,
    assigneeIds: item.assigneeIds,
    assigneeNames: [],
    url: null,
    detail: { ...item },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(proposalsService.createProposal).mockResolvedValue({ id: 'prop-abc1234' } as never);
  vi.mocked(nativeProvider.getByRef).mockResolvedValue(normalized() as never);
});

describe('conversation gating', () => {
  it('every propose handler refuses cleanly with no conversation id — read tools unaffected by design', async () => {
    const results = await Promise.all([
      proposeCommentHandler(null, null, { ticketId: 'wi-1', body: 'hi' }),
      proposeStateChangeHandler(null, null, { ticketId: 'wi-1', stateId: 'st-1' }),
      proposeAssigneeChangeHandler(null, { ticketId: 'wi-1', assigneeId: 'mem-2', action: 'add' }),
      proposePriorityChangeHandler(null, { ticketId: 'wi-1', priority: 'high' }),
      proposeCreateTicketHandler(null, { projectId: 'proj-1', title: 'x' }),
    ]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Proposals are unavailable in this session.');
    }
    // Refused before any fetch — the gate is the first thing checked.
    expect(ticketsService.getTicket).not.toHaveBeenCalled();
    expect(nativeProvider.getByRef).not.toHaveBeenCalled();
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });
});

describe('proposeCommentHandler', () => {
  it('treats a draft ticket as not found, same as the read tools hide drafts', async () => {
    // nativeProvider.getByRef is where the draft gate lives — it answers a
    // draft with null, exactly as it does for a ticket that isn't there.
    vi.mocked(nativeProvider.getByRef).mockResolvedValue(null);

    const result = await proposeCommentHandler(null, CONV, { ticketId: 'wi-1', body: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('ticket not found');
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('creates the proposal with the plain-text body and the display snapshot, returning the pending shape', async () => {
    const result = await proposeCommentHandler(null, CONV, { ticketId: 'wi-1', body: 'plain text' });

    expect(proposalsService.createProposal).toHaveBeenCalledWith({
      conversationId: CONV,
      kind: 'comment',
      ticketId: 'wi-1',
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
    vi.mocked(proposalsService.createProposal).mockRejectedValue(
      new proposalsService.ProposalValidationError(
        'Too many proposals this turn (max 10) — ask the user to act on the pending ones first.',
      ),
    );

    const result = await proposeCommentHandler(null, CONV, { ticketId: 'wi-1', body: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Too many proposals this turn/);
  });

  it('rethrows a non-validation createProposal failure for withErrorSafetyNet to scrub', async () => {
    vi.mocked(proposalsService.createProposal).mockRejectedValue(new Error('pg exploded'));

    await expect(proposeCommentHandler(null, CONV, { ticketId: 'wi-1', body: 'hi' })).rejects.toThrow(
      'pg exploded',
    );
  });

  // Regression: createProposal throws NotFoundError('conversation') when
  // the conversation row is gone (its own comment says this is meant to
  // "404-shape fail") — previously that fell through to the generic rethrow
  // and got scrubbed by withErrorSafetyNet into an opaque internal-error
  // message instead of a clean not-found result.
  it('maps a NotFoundError from createProposal (a gone conversation) to a clean not-found result, not a rethrow', async () => {
    const { NotFoundError } = await import('../middleware/errors.js');
    vi.mocked(proposalsService.createProposal).mockRejectedValue(new NotFoundError('conversation'));

    const result = await proposeCommentHandler(null, CONV, { ticketId: 'wi-1', body: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('conversation not found');
  });
});

describe('proposeStateChangeHandler', () => {
  it("rejects a stateId from a different project with a named validation error — the check updateTicket lacks", async () => {
    vi.mocked(statesService.listStates).mockResolvedValue([
      { id: 'st-progress', name: 'In Progress', color: '#f2c94c' },
    ] as never);

    const result = await proposeStateChangeHandler(null, CONV, {
      ticketId: 'wi-1',
      stateId: 'st-other-project',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not belong to this ticket's project/);
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('rejects a no-op move to the state the ticket is already in', async () => {
    vi.mocked(statesService.listStates).mockResolvedValue([
      { id: 'st-progress', name: 'In Progress', color: '#f2c94c' },
    ] as never);

    const result = await proposeStateChangeHandler(null, CONV, { ticketId: 'wi-1', stateId: 'st-progress' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already in In Progress/);
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('snapshots from/to names AND colors — the card must render names, never ids', async () => {
    vi.mocked(statesService.listStates).mockResolvedValue([
      { id: 'st-progress', name: 'In Progress', color: '#f2c94c' },
      { id: 'st-done', name: 'Done', color: '#157a3d' },
    ] as never);

    const result = await proposeStateChangeHandler(null, CONV, { ticketId: 'wi-1', stateId: 'st-done' });

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
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map());

    const result = await proposeAssigneeChangeHandler(CONV, {
      ticketId: 'wi-1',
      assigneeId: 'mem-ghost',
      action: 'add',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('assignee not found');
  });

  it('pre-checks direction: adding an already-assigned person is rejected at propose time', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(
      ticket({ assigneeIds: ['mem-2'] }) as never,
    );
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-2', 'Priya Sharma']]));

    const result = await proposeAssigneeChangeHandler(CONV, {
      ticketId: 'wi-1',
      assigneeId: 'mem-2',
      action: 'add',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Priya Sharma is already assigned to WI-1.');
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('pre-checks direction: removing someone not assigned is rejected at propose time', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-2', 'Priya Sharma']]));

    const result = await proposeAssigneeChangeHandler(CONV, {
      ticketId: 'wi-1',
      assigneeId: 'mem-2',
      action: 'remove',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Priya Sharma is not assigned to WI-1.');
  });

  it('snapshots the resolved name, wasAssigned, and the (empty) current-assignee context', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-2', 'Priya Sharma']]));

    await proposeAssigneeChangeHandler(CONV, { ticketId: 'wi-1', assigneeId: 'mem-2', action: 'add' });

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
    vi.mocked(ticketsService.getTicket).mockResolvedValue(
      ticket({ assigneeIds: ['mem-4'] }) as never,
    );
    vi.mocked(resolveActorNames).mockResolvedValue(
      new Map([
        ['mem-2', 'Priya Sharma'],
        ['mem-4', 'Lena Park'],
      ]),
    );

    await proposeAssigneeChangeHandler(CONV, { ticketId: 'wi-1', assigneeId: 'mem-2', action: 'add' });

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
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket({ priority: 'high' }) as never);

    const result = await proposePriorityChangeHandler(CONV, { ticketId: 'wi-1', priority: 'high' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already high/);
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('snapshots fromPriority for the from→to chips', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket({ priority: 'medium' }) as never);

    await proposePriorityChangeHandler(CONV, { ticketId: 'wi-1', priority: 'urgent' });

    expect(proposalsService.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { priority: 'urgent' },
        snapshot: expect.objectContaining({ fromPriority: 'medium' }),
      }),
    );
  });
});

describe('proposeCreateTicketHandler', () => {
  const STATES = [
    // Deliberately unsorted-looking groups: listStates returns board order
    // (sortOrder asc), so the FIRST backlog/unstarted entry in the returned
    // array is the default — a leading state in any other group (here
    // 'cancelled') must be skipped rather than picked for being first.
    { id: 'st-cancelled', name: 'Cancelled', color: '#b7332a', group: 'cancelled' },
    { id: 'st-backlog', name: 'Backlog', color: '#9c9280', group: 'backlog' },
    { id: 'st-todo', name: 'Todo', color: '#7d8a9c', group: 'unstarted' },
    { id: 'st-done', name: 'Done', color: '#157a3d', group: 'completed' },
  ];

  it('404s a missing project', async () => {
    vi.mocked(projectsService.getProject).mockResolvedValue(undefined as never);

    const result = await proposeCreateTicketHandler(CONV, { projectId: 'proj-x', title: 'New' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('project not found');
  });

  // Regression: getProject (unlike listProjects, which list_projects uses)
  // has no archived filter of its own — an archived project must still read
  // as a plain not-found here, same as a deleted one, so Copilot can't
  // create a real ticket in a project no UI list surfaces anymore.
  it('404s an archived project, same as a missing one', async () => {
    vi.mocked(projectsService.getProject).mockResolvedValue(
      { id: 'proj-1', name: 'P', identifier: 'P', archivedAt: new Date('2026-01-01') } as never,
    );

    const result = await proposeCreateTicketHandler(CONV, { projectId: 'proj-1', title: 'New' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('project not found');
    expect(statesService.listStates).not.toHaveBeenCalled();
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('defaults stateId to the first backlog/unstarted state in board order when omitted', async () => {
    vi.mocked(projectsService.getProject).mockResolvedValue(
      { id: 'proj-1', name: 'Launch', identifier: 'LAUNCH' } as never,
    );
    vi.mocked(statesService.listStates).mockResolvedValue(STATES as never);

    await proposeCreateTicketHandler(CONV, { projectId: 'proj-1', title: 'New ticket' });

    expect(proposalsService.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create_ticket',
        ticketId: null,
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

    const result = await proposeCreateTicketHandler(CONV, { projectId: 'proj-1', title: 'New' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no backlog or unstarted state/);
  });

  it("rejects an explicit stateId that isn't one of the project's states", async () => {
    vi.mocked(projectsService.getProject).mockResolvedValue({ id: 'proj-1', name: 'P', identifier: 'P' } as never);
    vi.mocked(statesService.listStates).mockResolvedValue(STATES as never);

    const result = await proposeCreateTicketHandler(CONV, {
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

    const bad = await proposeCreateTicketHandler(CONV, {
      projectId: 'proj-1',
      title: 'New',
      assigneeIds: ['mem-2', 'mem-ghost'],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/unknown assignee id\(s\): mem-ghost/);

    await proposeCreateTicketHandler(CONV, {
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

// ---------------------------------------------------------------------------
// Proposing against a Jira issue
// ---------------------------------------------------------------------------

describe('proposing against a Jira issue', () => {
  const JIRA_REF = 'tref-abc1234';

  const JIRA_TICKET = {
    provider: 'jira' as const,
    ref: JIRA_REF,
    identifier: 'ENG-4',
    title: 'Checkout 500s on Safari 17.4',
    projectId: 'ENG',
    stateId: '10001',
    stateName: 'In Progress',
    stateGroup: 'started',
    priority: 'urgent',
    dueDate: null,
    assigneeIds: [],
    assigneeNames: [],
    url: 'https://yourteam.atlassian.net/browse/ENG-4',
    detail: { updatedAt: '2026-01-02T03:04:05.000Z' },
  };

  function jiraStub() {
    return {
      getByRef: vi.fn(async () => JIRA_TICKET),
      listTransitions: vi.fn(async () => [
        { id: '11', name: 'Start progress', group: 'started' },
        { id: '31', name: 'Done', group: 'completed' },
      ]),
      site: 'yourteam.atlassian.net',
      actorName: 'Max Chen',
    };
  }

  it('captures who, where and who-finds-out on the snapshot the approval card renders', async () => {
    const jira = jiraStub();

    await proposeCommentHandler(jira as never, CONV, {
      ticketId: JIRA_REF,
      body: 'Reproduced on staging.',
    });

    const { snapshot } = vi.mocked(proposalsService.createProposal).mock.calls[0][0];
    expect(snapshot).toMatchObject({
      identifier: 'ENG-4',
      itemUpdatedAt: '2026-01-02T03:04:05.000Z',
      provider: 'jira',
      externalSite: 'yourteam.atlassian.net',
      externalUrl: 'https://yourteam.atlassian.net/browse/ENG-4',
      // The Jira account the comment will post AS — not the Waypoint user,
      // and not the model.
      externalActorName: 'Max Chen',
    });
    expect(snapshot.externalNotifiesLabel).toMatch(/watchers/);
    // The native path is unchanged: no provider field, so an existing card
    // renders exactly as it did.
    expect(nativeProvider.getByRef).not.toHaveBeenCalled();
  });

  it('says Jira is not connected rather than reporting the issue missing', async () => {
    const result = await proposeCommentHandler(null, CONV, { ticketId: JIRA_REF, body: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Jira is not connected');
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  // A Jira transition id is a small integer, which is exactly the shape a
  // model will invent. Caught here, with the tool to call named, it can
  // correct itself next turn; accepted, it would sit in a proposal until
  // somebody approved it and Jira answered 400.
  it('refuses a transition id the issue cannot actually make right now', async () => {
    const jira = jiraStub();

    const result = await proposeStateChangeHandler(jira as never, CONV, {
      ticketId: JIRA_REF,
      stateId: '99',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('list_states');
    expect(result.content[0].text).toContain(JIRA_REF);
    // The live options, named, so the next call does not have to guess again.
    expect(result.content[0].text).toContain('Done (31)');
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });

  it('stores the transition id as the payload and the live STATUS id as the from-state', async () => {
    const jira = jiraStub();

    await proposeStateChangeHandler(jira as never, CONV, { ticketId: JIRA_REF, stateId: '31' });

    const call = vi.mocked(proposalsService.createProposal).mock.calls[0][0];
    expect(call.payload).toEqual({ stateId: '31' });
    expect(call.snapshot).toMatchObject({
      // The issue's status id, NOT the transition id — this is what
      // checkStaleness re-reads to notice somebody else moved the issue.
      fromStateId: '10001',
      fromStateName: 'In Progress',
      // The transition's own label, read live from this site rather than
      // supplied by the model.
      toStateName: 'Done',
      provider: 'jira',
    });
  });

  it.each([
    ['assignee', () => proposeAssigneeChangeHandler(CONV, { ticketId: JIRA_REF, assigneeId: 'mem-2', action: 'add' })],
    ['priority', () => proposePriorityChangeHandler(CONV, { ticketId: JIRA_REF, priority: 'high' })],
  ])('tells the model %s changes are unsupported for Jira, rather than reporting a miss', async (_kind, run) => {
    const result = await run();

    expect(result.isError).toBe(true);
    // "not found" would be a lie with a plausible shape — the issue exists,
    // and told that, the model would just look it up and ask again.
    expect(result.content[0].text).toMatch(/not supported for Jira issues/);
    expect(ticketsService.getTicket).not.toHaveBeenCalled();
    expect(proposalsService.createProposal).not.toHaveBeenCalled();
  });
});
