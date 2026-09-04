import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same mocking shape as ticketTools.test.ts: these tests verify the MCP
// tool handlers' own logic (which service function they call, with what
// args, how a result is shaped), not sprints.service.ts/tickets.service.ts's
// own behavior (covered separately in their own *.test.ts files).
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/sprints.service.js');
vi.mock('../services/tickets.service.js');
vi.mock('../services/states.service.js');
vi.mock('../lib/actorNames.js');

const sprintsService = await import('../services/sprints.service.js');
const ticketsService = await import('../services/tickets.service.js');
const statesService = await import('../services/states.service.js');
const { resolveActorNames } = await import('../lib/actorNames.js');
const { resolveStateNames } = statesService;
const { listSprintsHandler, getSprintHandler } = await import('./sprintTools.js');

function parseJsonContent(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

const SPRINT = {
  id: 'sp-1',
  projectId: 'proj-1',
  name: 'Sprint 12',
  description: 'Auth cleanup',
  startDate: '2026-08-25',
  endDate: '2026-09-08',
  leadId: 'mem-1',
  memberIds: ['mem-1', 'mem-2'],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ticketsService.listTicketsByFilter).mockResolvedValue([]);
  vi.mocked(resolveStateNames).mockResolvedValue(new Map());
  vi.mocked(resolveActorNames).mockResolvedValue(new Map());
});

describe('listSprintsHandler', () => {
  it('calls listAllSprints when no projectId is given', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT]);

    await listSprintsHandler({});

    expect(sprintsService.listAllSprints).toHaveBeenCalled();
    expect(sprintsService.listSprints).not.toHaveBeenCalled();
  });

  it('calls listSprints(projectId) when a projectId is given', async () => {
    vi.mocked(sprintsService.listSprints).mockResolvedValue([SPRINT]);

    await listSprintsHandler({ projectId: 'proj-1' });

    expect(sprintsService.listSprints).toHaveBeenCalledWith('proj-1');
    expect(sprintsService.listAllSprints).not.toHaveBeenCalled();
  });

  it('returns a summary with dates, lead, and members for each sprint — this is the tool that lets Copilot see sprints exist at all', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT]);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-1', 'Priya']]));

    const result = await listSprintsHandler({});

    expect(parseJsonContent(result)).toEqual([
      {
        id: 'sp-1',
        name: 'Sprint 12',
        description: 'Auth cleanup',
        projectId: 'proj-1',
        startDate: '2026-08-25',
        endDate: '2026-09-08',
        leadId: 'mem-1',
        leadName: 'Priya',
        memberIds: ['mem-1', 'mem-2'],
        ticketCount: 0,
        doneCount: 0,
      },
    ]);
  });

  it('falls back to the raw leadId when it cannot be resolved, and to null when there is no lead at all', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT, { ...SPRINT, id: 'sp-2', leadId: null }]);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map());

    const [withLead, withoutLead] = parseJsonContent(await listSprintsHandler({}));

    expect(withLead.leadName).toBe('mem-1');
    expect(withoutLead.leadName).toBeNull();
  });

  it('fetches the sprint\'s tickets via listTicketsByFilter(sprintIds) and counts ticketCount/doneCount from resolved state groups', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT]);
    vi.mocked(ticketsService.listTicketsByFilter).mockResolvedValue([
      { id: 'wi-1', stateId: 'st-done' },
      { id: 'wi-2', stateId: 'st-progress' },
      { id: 'wi-3', stateId: 'st-done' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    vi.mocked(resolveStateNames).mockResolvedValue(
      new Map([
        ['st-done', { name: 'Done', group: 'completed' }],
        ['st-progress', { name: 'In Progress', group: 'started' }],
      ]),
    );

    const result = await listSprintsHandler({});

    expect(ticketsService.listTicketsByFilter).toHaveBeenCalledWith({ sprintIds: ['sp-1'] });
    const parsed = parseJsonContent(result)[0];
    expect(parsed.ticketCount).toBe(3);
    expect(parsed.doneCount).toBe(2);
  });
});

describe('getSprintHandler', () => {
  it('returns a not-found result when the sprint does not exist', async () => {
    vi.mocked(sprintsService.getSprint).mockResolvedValue(undefined);

    const result = await getSprintHandler({ id: 'sp-missing' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('returns the same summary shape as listSprintsHandler for a found sprint', async () => {
    vi.mocked(sprintsService.getSprint).mockResolvedValue(SPRINT);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-1', 'Priya']]));

    const result = await getSprintHandler({ id: 'sp-1' });

    expect(sprintsService.getSprint).toHaveBeenCalledWith('sp-1');
    expect(parseJsonContent(result)).toEqual({
      id: 'sp-1',
      name: 'Sprint 12',
      description: 'Auth cleanup',
      projectId: 'proj-1',
      startDate: '2026-08-25',
      endDate: '2026-09-08',
      leadId: 'mem-1',
      leadName: 'Priya',
      memberIds: ['mem-1', 'mem-2'],
      ticketCount: 0,
      doneCount: 0,
    });
  });
});
