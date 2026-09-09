import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same mocking shape as ticketTools.test.ts: these tests verify the MCP
// tool handlers' own logic (which service function they call, with what
// args, how a result is shaped), not sprints.service.ts/tickets.service.ts's
// own behavior (covered separately in their own *.test.ts files).
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/sprints.service.js');
vi.mock('../services/tickets.service.js');
vi.mock('../lib/actorNames.js');

const sprintsService = await import('../services/sprints.service.js');
const ticketsService = await import('../services/tickets.service.js');
const { resolveActorNames } = await import('../lib/actorNames.js');
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
  vi.mocked(ticketsService.countTicketsBySprintIds).mockResolvedValue(new Map());
  vi.mocked(resolveActorNames).mockResolvedValue(new Map());
  // Fixed "now" so daysLeft — computed server-side precisely so the model
  // never has to guess today's date itself (see sprintTools.ts's own
  // comment on the real bug this fixes: Copilot reporting "6 days
  // remaining" for a sprint the Home dashboard correctly showed 8 days
  // left for) — is deterministic across test runs.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listSprintsHandler', () => {
  it('calls listAllSprints with limit + 1 when no projectId is given', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT]);

    await listSprintsHandler({});

    // DEFAULT_LIST_LIMIT (50) + 1 — see ticketTools.ts's own page()/
    // resolveLimit() convention, reused here for exactly this reason.
    expect(sprintsService.listAllSprints).toHaveBeenCalledWith(51);
    expect(sprintsService.listSprints).not.toHaveBeenCalled();
  });

  it('calls listSprints(projectId, limit + 1) when a projectId is given', async () => {
    vi.mocked(sprintsService.listSprints).mockResolvedValue([SPRINT]);

    await listSprintsHandler({ projectId: 'proj-1' });

    expect(sprintsService.listSprints).toHaveBeenCalledWith('proj-1', 51);
    expect(sprintsService.listAllSprints).not.toHaveBeenCalled();
  });

  it('respects an explicit limit, requesting limit + 1 rows', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT]);

    await listSprintsHandler({ limit: 5 });

    expect(sprintsService.listAllSprints).toHaveBeenCalledWith(6);
  });

  it('returns a summary with dates, lead, and members for each sprint — this is the tool that lets Copilot see sprints exist at all', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT]);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-1', 'Priya']]));

    const result = await listSprintsHandler({});

    expect(parseJsonContent(result)).toEqual({
      items: [
        {
          id: 'sp-1',
          name: 'Sprint 12',
          description: 'Auth cleanup',
          projectId: 'proj-1',
          startDate: '2026-08-25',
          endDate: '2026-09-08',
          daysLeft: 7,
          leadId: 'mem-1',
          leadName: 'Priya',
          memberIds: ['mem-1', 'mem-2'],
          ticketCount: 0,
          doneCount: 0,
        },
      ],
      truncated: false,
    });
  });

  it('computes daysLeft server-side rather than handing the model raw dates to subtract itself', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([
      { ...SPRINT, id: 'sp-future', endDate: '2026-09-10' },
      { ...SPRINT, id: 'sp-today', endDate: '2026-09-01' },
      { ...SPRINT, id: 'sp-past', endDate: '2026-08-20' },
    ]);

    const { items } = parseJsonContent(await listSprintsHandler({}));
    const [future, today, past] = items;

    expect(future.daysLeft).toBe(9);
    expect(today.daysLeft).toBe(0);
    // Never negative — an overdue sprint reads as "0 days left", not "-12".
    expect(past.daysLeft).toBe(0);
  });

  it('falls back to the raw leadId when it cannot be resolved, and to null when there is no lead at all', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT, { ...SPRINT, id: 'sp-2', leadId: null }]);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map());

    const { items } = parseJsonContent(await listSprintsHandler({}));
    const [withLead, withoutLead] = items;

    expect(withLead.leadName).toBe('mem-1');
    expect(withoutLead.leadName).toBeNull();
  });

  it('resolves lead names in one batched call across every sprint on the page, not one call per sprint', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([
      SPRINT,
      { ...SPRINT, id: 'sp-2', leadId: 'mem-2' },
      { ...SPRINT, id: 'sp-3', leadId: null },
    ]);

    await listSprintsHandler({});

    expect(resolveActorNames).toHaveBeenCalledTimes(1);
    expect(resolveActorNames).toHaveBeenCalledWith(['mem-1', 'mem-2']);
  });

  it('gets ticketCount/doneCount from a single batched countTicketsBySprintIds call, not per-sprint materialization', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT, { ...SPRINT, id: 'sp-2', leadId: null }]);
    vi.mocked(ticketsService.countTicketsBySprintIds).mockResolvedValue(
      new Map([
        ['sp-1', { total: 3, done: 2 }],
        ['sp-2', { total: 1, done: 0 }],
      ]),
    );

    const result = await listSprintsHandler({});

    expect(ticketsService.countTicketsBySprintIds).toHaveBeenCalledTimes(1);
    expect(ticketsService.countTicketsBySprintIds).toHaveBeenCalledWith(['sp-1', 'sp-2']);
    const { items } = parseJsonContent(result);
    expect(items[0].ticketCount).toBe(3);
    expect(items[0].doneCount).toBe(2);
    expect(items[1].ticketCount).toBe(1);
    expect(items[1].doneCount).toBe(0);
  });

  it('reports 0/0 for a sprint absent from the counts map, rather than throwing', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT]);
    vi.mocked(ticketsService.countTicketsBySprintIds).mockResolvedValue(new Map());

    const { items } = parseJsonContent(await listSprintsHandler({}));

    expect(items[0].ticketCount).toBe(0);
    expect(items[0].doneCount).toBe(0);
  });

  // Same convention as ticketTools.ts's own list tools: the query layer
  // fetches one row past the effective limit, and a genuinely full page is
  // told apart from a truncated one by whether that extra row came back —
  // not by counting every sprint in the workspace.
  it('caps the page and reports truncated:true when more sprints exist than the limit', async () => {
    const sprints = Array.from({ length: 51 }, (_, i) => ({ ...SPRINT, id: `sp-${i}` }));
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue(sprints);

    const { items, truncated } = parseJsonContent(await listSprintsHandler({}));

    expect(truncated).toBe(true);
    expect(items).toHaveLength(50);
  });

  it('reports truncated:false when the result fits within the limit', async () => {
    vi.mocked(sprintsService.listAllSprints).mockResolvedValue([SPRINT]);

    const { truncated } = parseJsonContent(await listSprintsHandler({}));

    expect(truncated).toBe(false);
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
      daysLeft: 7,
      leadId: 'mem-1',
      leadName: 'Priya',
      memberIds: ['mem-1', 'mem-2'],
      ticketCount: 0,
      doneCount: 0,
    });
  });

  // The regression this whole ticket exists to fix, exercised end-to-end
  // through the handler: a sprint with 2 done tickets and 3 not-done ones
  // (5 total) must still report ticketCount:5, doneCount:2 now that the
  // count comes from a real COUNT(*) (ticketsService.countTicketsBySprintIds)
  // instead of materializing every ticket row and filtering/counting in JS.
  it('reports correct ticketCount/doneCount for a sprint with 2 done and 3 not-done tickets', async () => {
    vi.mocked(sprintsService.getSprint).mockResolvedValue(SPRINT);
    vi.mocked(ticketsService.countTicketsBySprintIds).mockResolvedValue(
      new Map([['sp-1', { total: 5, done: 2 }]]),
    );

    const result = await getSprintHandler({ id: 'sp-1' });

    expect(ticketsService.countTicketsBySprintIds).toHaveBeenCalledWith(['sp-1']);
    const parsed = parseJsonContent(result);
    expect(parsed.ticketCount).toBe(5);
    expect(parsed.doneCount).toBe(2);
  });
});
