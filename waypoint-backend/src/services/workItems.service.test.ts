import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same mocking convention as copilot.service.test.ts: fakes Drizzle's fluent
// query builder shape, not a real database — these tests verify this
// function's own query construction (which columns/conditions it passes),
// not real Postgres filtering behavior.
function chainable(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'orderBy', 'limit', 'innerJoin'];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => void) => resolve(resolvedValue);
  return chain;
}

const { db } = vi.hoisted(() => ({
  db: { select: vi.fn() },
}));
vi.mock('../db/client.js', () => ({ db }));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(actual.eq),
    and: vi.fn(actual.and),
    ilike: vi.fn(actual.ilike),
    lte: vi.fn(actual.lte),
    inArray: vi.fn(actual.inArray),
  };
});

const { workItems, workItemAssignees } = await import('../db/schema/index.js');
const { searchWorkItems, listAllWorkItems, listWorkItems } = await import('./workItems.service.js');
const { eq, ilike, lte, inArray } = await import('drizzle-orm');

beforeEach(() => {
  vi.clearAllMocks();
  // attachRelations' three relation queries (labels/assignees/links) — the
  // main search query is set per-test via mockReturnValueOnce, so these
  // empty fallbacks only ever back the relation lookups that follow it.
  db.select.mockReturnValue(chainable([]));
});

describe('searchWorkItems', () => {
  it('matches on title (case-insensitively) and excludes drafts, with no project filter by default', async () => {
    const rows = [{ id: 'wi-1', title: 'Fix login bug', isDraft: false }];
    db.select.mockReturnValueOnce(chainable(rows));

    const result = await searchWorkItems('login');

    expect(ilike).toHaveBeenCalledWith(workItems.title, '%login%');
    expect(eq).toHaveBeenCalledWith(workItems.isDraft, false);
    expect(result).toEqual([{ ...rows[0], assigneeIds: [], labelIds: [], links: [] }]);
  });

  it('filters to one project when projectId is given', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await searchWorkItems('login', 'proj-1');

    expect(eq).toHaveBeenCalledWith(workItems.projectId, 'proj-1');
  });

  it('does not filter by projectId when it is omitted', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await searchWorkItems('login');

    expect(eq).not.toHaveBeenCalledWith(workItems.projectId, expect.anything());
  });

  // Regression test: a literal `%` or `_` in the query is a LIKE wildcard,
  // not a literal character — unescaped, `search_work_items({query: "%"})`
  // matched every row instead of the literal "%" character.
  it('escapes LIKE metacharacters (%, _, \\) in the query before building the pattern', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await searchWorkItems('100%_off\\sale');

    expect(ilike).toHaveBeenCalledWith(workItems.title, '%100\\%\\_off\\\\sale%');
  });

  it('does not let a bare "%" query match every row — it is escaped to a literal', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await searchWorkItems('%');

    expect(ilike).toHaveBeenCalledWith(workItems.title, '%\\%%');
  });

  it('applies a limit at the query layer when given, not as a post-fetch slice', async () => {
    const searchChain = chainable([]);
    db.select.mockReturnValueOnce(searchChain);

    await searchWorkItems('login', undefined, 51);

    expect(searchChain.limit).toHaveBeenCalledWith(51);
  });

  it('does not call limit() at all when no limit is given', async () => {
    const searchChain = chainable([]);
    db.select.mockReturnValueOnce(searchChain);

    await searchWorkItems('login');

    expect(searchChain.limit).not.toHaveBeenCalled();
  });
});

describe('listAllWorkItems filters', () => {
  it('applies no extra conditions when no filters are given', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await listAllWorkItems();

    expect(eq).toHaveBeenCalledWith(workItems.isDraft, false);
    expect(eq).not.toHaveBeenCalledWith(workItems.stateId, expect.anything());
    expect(lte).not.toHaveBeenCalled();
  });

  it('filters by stateId, priority, and dueBefore', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await listAllWorkItems({ stateId: 'st-1', priority: 'urgent', dueBefore: '2026-09-01' });

    expect(eq).toHaveBeenCalledWith(workItems.stateId, 'st-1');
    expect(eq).toHaveBeenCalledWith(workItems.priority, 'urgent');
    expect(lte).toHaveBeenCalledWith(workItems.dueDate, '2026-09-01');
  });

  it('resolves assigneeId via a pre-query against workItemAssignees (unscoped by project), then filters workItems.id by the result', async () => {
    const assigneeChain = chainable([{ workItemId: 'wi-1' }, { workItemId: 'wi-2' }]);
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(assigneeChain).mockReturnValueOnce(mainChain);

    await listAllWorkItems({ assigneeId: 'mem-4' });

    expect(assigneeChain.from).toHaveBeenCalledWith(workItemAssignees);
    expect(assigneeChain.innerJoin).not.toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith(workItemAssignees.assigneeId, 'mem-4');
    expect(inArray).toHaveBeenCalledWith(workItems.id, ['wi-1', 'wi-2']);
  });

  it('short-circuits to an empty result, never querying workItems, when the assignee has no items', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    const result = await listAllWorkItems({ assigneeId: 'mem-nobody' });

    expect(result).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('applies a limit at the query layer when given', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain);

    await listAllWorkItems({ limit: 51 });

    expect(mainChain.limit).toHaveBeenCalledWith(51);
  });

  // Regression test: the assigneeId pre-query had no limit at all here —
  // listAllWorkItems has no projectId to scope it by, so a heavy assignee
  // made this pre-query fetch every one of their items before the main
  // query's own .limit() (asserted above) ever got a chance to matter. The
  // pre-query now passes the caller's own limit through to bound that
  // worst case too.
  it('caps the unscoped assigneeId pre-query at the caller-given limit', async () => {
    const assigneeChain = chainable([{ workItemId: 'wi-1' }]);
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(assigneeChain).mockReturnValueOnce(mainChain);

    await listAllWorkItems({ assigneeId: 'mem-4', limit: 51 });

    expect(assigneeChain.limit).toHaveBeenCalledWith(51);
  });

  it('falls back to a default cap on the unscoped assigneeId pre-query when no limit is given', async () => {
    const assigneeChain = chainable([{ workItemId: 'wi-1' }]);
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(assigneeChain).mockReturnValueOnce(mainChain);

    await listAllWorkItems({ assigneeId: 'mem-4' });

    expect(assigneeChain.limit).toHaveBeenCalledWith(expect.any(Number));
    expect((assigneeChain.limit as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeGreaterThan(0);
  });
});

describe('listWorkItems filters', () => {
  it('combines the project scope with the given filters', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await listWorkItems('proj-1', { priority: 'high' });

    expect(eq).toHaveBeenCalledWith(workItems.projectId, 'proj-1');
    expect(eq).toHaveBeenCalledWith(workItems.priority, 'high');
  });

  // Regression test: the assignee pre-query previously ran against every
  // work item assigned to that member across the whole app, regardless of
  // project — a heavy assignee on a large workspace built an unnecessarily
  // huge IN (...) list before the project filter (applied only to the main
  // query afterward) ever had a chance to narrow it. Scoping the pre-query
  // itself by project (via a join) fixes that.
  it('scopes the assigneeId pre-query to the given project via a join, not just the main query', async () => {
    const assigneeChain = chainable([{ workItemId: 'wi-1' }]);
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(assigneeChain).mockReturnValueOnce(mainChain);

    await listWorkItems('proj-1', { assigneeId: 'mem-4' });

    expect(assigneeChain.from).toHaveBeenCalledWith(workItemAssignees);
    expect(assigneeChain.innerJoin).toHaveBeenCalledWith(workItems, expect.anything());
    expect(eq).toHaveBeenCalledWith(workItemAssignees.assigneeId, 'mem-4');
    expect(eq).toHaveBeenCalledWith(workItems.projectId, 'proj-1');
  });

  it('applies a limit at the query layer when given', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain);

    await listWorkItems('proj-1', { limit: 51 });

    expect(mainChain.limit).toHaveBeenCalledWith(51);
  });

  it('also caps the project-scoped assigneeId pre-query at the caller-given limit', async () => {
    const assigneeChain = chainable([{ workItemId: 'wi-1' }]);
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(assigneeChain).mockReturnValueOnce(mainChain);

    await listWorkItems('proj-1', { assigneeId: 'mem-4', limit: 51 });

    expect(assigneeChain.limit).toHaveBeenCalledWith(51);
  });
});
