import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, ValidationError } from '../middleware/errors.js';

// W5b (ROAD-126): createRunProposal on a Jira issue — the run's ticket is a
// `tref-` handle, and the proposal it files must be exactly the card
// Copilot's propose_comment / propose_state_change would have filed: the
// external-write snapshot, a transition id checked live, a null project.
// Kept in its own file so proposals.service.test.ts stays as it was; same
// mocked-Drizzle approach — this proves the service's own orchestration
// (what is read, what is written, what is refused), not Postgres.
function chainable(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'set'];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  chain.returning = vi.fn(() => Promise.resolve(resolvedValue));
  chain.then = (resolve: (value: unknown) => void) => resolve(resolvedValue);
  return chain;
}

const { db } = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../db/client.js', () => ({ db }));

vi.mock('./tickets.service.js');
vi.mock('./comments.service.js');
vi.mock('./states.service.js');
vi.mock('./members.service.js');
vi.mock('./projects.service.js');
vi.mock('./agentRuns.service.js');
// Only the provider FACTORY is mocked; isExternalRef stays real — the
// prefix rule is what routes a run's proposal to the Jira branch at all.
vi.mock('../providers/jira.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/jira.js')>()),
  getJiraProvider: vi.fn(),
}));

const ticketsService = await import('./tickets.service.js');
const statesService = await import('./states.service.js');
const agentRunsService = await import('./agentRuns.service.js');
const { getJiraProvider } = await import('../providers/jira.js');
const { createRunProposal, RUN_PROPOSAL_TTL_MS } = await import('./proposals.service.js');

const CREDENTIAL = {
  site: 'yourteam.atlassian.net',
  email: 'max@example.com',
  apiToken: 'tok',
  displayName: 'Max Chen',
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-abc1234',
    projectId: null,
    ticketId: 'tref-abc1234',
    agentId: null,
    copilotConversationId: null,
    intent: 'fix',
    ...overrides,
  } as never;
}

function jiraIssue(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'jira',
    ref: 'tref-abc1234',
    identifier: 'ENG-4',
    title: 'Checkout 500s',
    projectId: 'ENG',
    stateId: '10001',
    stateName: 'In Progress',
    stateGroup: 'started',
    priority: 'high',
    dueDate: null,
    assigneeIds: [],
    assigneeNames: [],
    url: 'https://yourteam.atlassian.net/browse/ENG-4',
    detail: { updatedAt: '2026-09-13T10:00:00.000Z' },
    ...overrides,
  };
}

function jiraStub() {
  return {
    getByRef: vi.fn(async () => jiraIssue()),
    listTransitions: vi.fn(async () => [
      { id: '21', name: 'In Review', group: 'started' },
      { id: '31', name: 'Done', group: 'completed' },
    ]),
    site: 'yourteam.atlassian.net',
    actorName: 'Max Chen',
  };
}

function connectJira() {
  const stub = jiraStub();
  vi.mocked(getJiraProvider).mockReturnValue(stub as never);
  return stub;
}

function insertedRow() {
  const chain = chainable([{ id: 'prop-1' }]);
  db.insert.mockReturnValueOnce(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getJiraProvider).mockReturnValue(null);
});

describe('createRunProposal on a Jira issue (W5b)', () => {
  it('reads the issue live with the borrowed credential and files the external-write card, project null', async () => {
    const jira = connectJira();
    vi.mocked(agentRunsService.getRun).mockResolvedValue(run());
    const insert = insertedRow();

    await createRunProposal(
      { agentRunId: 'run-abc1234', kind: 'comment', payload: { body: '## Root cause\nThe retry path.' } },
      CREDENTIAL,
    );

    expect(getJiraProvider).toHaveBeenCalledWith(CREDENTIAL);
    expect(jira.getByRef).toHaveBeenCalledWith('tref-abc1234');
    // Never the native ticket table: a tref id is not a row there.
    expect(ticketsService.getTicket).not.toHaveBeenCalled();
    const values = (insert.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(values).toMatchObject({
      origin: 'agent_run',
      agentRunId: 'run-abc1234',
      kind: 'comment',
      ticketId: 'tref-abc1234',
      payload: { body: '## Root cause\nThe retry path.' },
      // A Jira issue belongs to no Waypoint project — the same answer
      // Copilot's proposals on a Jira issue store.
      projectId: null,
      conversationId: null,
      anchorSeq: null,
    });
    // The snapshot is Copilot's, byte for byte: what the card renders
    // before anyone approves a write that leaves Waypoint.
    expect(values.snapshot).toEqual({
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      itemUpdatedAt: '2026-09-13T10:00:00.000Z',
      provider: 'jira',
      externalSite: 'yourteam.atlassian.net',
      externalUrl: 'https://yourteam.atlassian.net/browse/ENG-4',
      externalActorName: 'Max Chen',
      externalNotifiesLabel:
        "the issue's watchers and assignee will be notified, per your Jira notification scheme",
    });
    // A run's proposal keeps a month (the W5a rule), Jira or not.
    expect(values.expiresAt.getTime() - Date.now()).toBeGreaterThan(RUN_PROPOSAL_TTL_MS - 5_000);
  });

  it('files a transition the issue offers, with the live status id as fromStateId', async () => {
    const jira = connectJira();
    vi.mocked(agentRunsService.getRun).mockResolvedValue(run());
    const insert = insertedRow();

    await createRunProposal(
      { agentRunId: 'run-abc1234', kind: 'state_change', payload: { stateId: '21' } },
      CREDENTIAL,
    );

    expect(jira.listTransitions).toHaveBeenCalledWith('tref-abc1234');
    const values = (insert.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(values.payload).toEqual({ stateId: '21' });
    expect(values.snapshot).toMatchObject({
      fromStateId: '10001',
      fromStateName: 'In Progress',
      fromStateColor: null,
      toStateName: 'In Review',
      toStateColor: null,
      provider: 'jira',
      externalSite: 'yourteam.atlassian.net',
    });
    // The native states service is never consulted for a Jira issue.
    expect(statesService.listStates).not.toHaveBeenCalled();
  });

  it('refuses a transition the issue does not offer right now', async () => {
    connectJira();
    vi.mocked(agentRunsService.getRun).mockResolvedValue(run());

    await expect(
      createRunProposal(
        { agentRunId: 'run-abc1234', kind: 'state_change', payload: { stateId: '99' } },
        CREDENTIAL,
      ),
    ).rejects.toThrow(ValidationError);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses without a credential — Jira disconnected is a sentence, not a crash', async () => {
    vi.mocked(agentRunsService.getRun).mockResolvedValue(run());

    await expect(
      createRunProposal({ agentRunId: 'run-abc1234', kind: 'comment', payload: { body: 'x' } }, null),
    ).rejects.toThrow(/Jira is not connected/);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('404s when the issue is gone from Jira', async () => {
    const jira = connectJira();
    jira.getByRef.mockResolvedValue(null as never);
    vi.mocked(agentRunsService.getRun).mockResolvedValue(run());

    await expect(
      createRunProposal({ agentRunId: 'run-abc1234', kind: 'comment', payload: { body: 'x' } }, CREDENTIAL),
    ).rejects.toThrow(NotFoundError);
  });

  it('still takes the native path for a native ticket, credential or not', async () => {
    connectJira();
    vi.mocked(agentRunsService.getRun).mockResolvedValue(run({ ticketId: 'wi-1', projectId: 'proj-1' }));
    vi.mocked(ticketsService.getTicket).mockResolvedValue({
      id: 'wi-1',
      identifier: 'ROAD-1',
      title: 'Native',
      projectId: 'proj-1',
      stateId: 'st-1',
      updatedAt: new Date('2026-09-13T10:00:00.000Z'),
    } as never);
    const insert = insertedRow();

    await createRunProposal(
      { agentRunId: 'run-abc1234', kind: 'comment', payload: { body: 'x' } },
      CREDENTIAL,
    );

    const values = (insert.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(values).toMatchObject({ ticketId: 'wi-1', projectId: 'proj-1' });
    expect(values.snapshot).toEqual({
      identifier: 'ROAD-1',
      title: 'Native',
      itemUpdatedAt: '2026-09-13T10:00:00.000Z',
    });
    expect(getJiraProvider).not.toHaveBeenCalled();
  });
});
