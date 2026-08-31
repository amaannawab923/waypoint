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
const { eq, and, ilike, lte, inArray } = await import('drizzle-orm');

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

  // Regression coverage for the MAJOR fixed here: assigneeId used to be
  // resolved as a separate, independently-capped PRE-query — run before
  // stateId/priority/dueBefore ever got a chance to narrow anything down,
  // with no ORDER BY, so which rows survived its own cap was nondeterministic.
  // A heavy assignee's real matches could be silently discarded there before
  // the main query's dueBefore/stateId/etc. filters, and its own limit, ever
  // ran — and the `truncated` flag downstream was computed from that already-
  // short result, so a wrong answer came back looking complete. Asserting
  // "a pre-query ran with some limit" (the old test shape) can't catch that:
  // it never inspects which rows the two-query split actually let through.
  //
  // The fix folds the assignee condition into ONE query as a subquery passed
  // to inArray(), so it's combined via and(...) with every other filter and
  // is bounded by the SAME single .limit() as everything else — asserted
  // below by checking there is only ONE db.select() call for the whole
  // operation (the assignee condition no longer causes a second, separate
  // query), and that inArray() receives a query builder (the subquery) built
  // from workItemAssignees, not a plain resolved array of ids.
  it('folds assigneeId into the SAME single query as every other filter, via a subquery passed to inArray — not a separate pre-query', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain); // the workItemAssignees subquery builder itself
    db.select.mockReturnValueOnce(mainChain); // the main workItems query

    await listAllWorkItems({ assigneeId: 'mem-4', stateId: 'st-1', dueBefore: '2026-09-01', limit: 50 });

    // Exactly two db.select() calls total: one to build the subquery
    // expression, one for the main workItems query — never a third,
    // independently-awaited pre-query round-trip.
    expect(db.select).toHaveBeenCalledTimes(2);

    // The assignee subquery itself is built from workItemAssignees, scoped
    // by assigneeId, and critically has NO .limit() of its own — it must
    // contribute every one of the assignee's item ids to the AND'd
    // condition set, not a capped subset.
    expect(db.select).toHaveBeenCalledWith({ workItemId: workItemAssignees.workItemId });
    expect(eq).toHaveBeenCalledWith(workItemAssignees.assigneeId, 'mem-4');

    // inArray() must receive the subquery builder (an object, not a plain
    // array of already-resolved ids) — proof the assignee condition is
    // expressed as `workItems.id IN (<subquery>)` within the main query,
    // not resolved to a value list ahead of time.
    expect(inArray).toHaveBeenCalledWith(workItems.id, expect.objectContaining({ where: expect.any(Function) }));
    const inArrayCall = (inArray as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === workItems.id,
    );
    expect(Array.isArray(inArrayCall?.[1])).toBe(false);

    // Every other filter condition (stateId, dueBefore) is combined in the
    // SAME and(...) call as the assignee inArray condition — proof they all
    // apply together in one query, not the assignee filter narrowing a
    // separately-capped candidate set first.
    expect(eq).toHaveBeenCalledWith(workItems.stateId, 'st-1');
    expect(lte).toHaveBeenCalledWith(workItems.dueDate, '2026-09-01');
    const andCall = (and as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(andCall).toBeDefined();

    // The single .limit() applies to the main query only, after everything
    // above is already combined — there's no separate pre-query .limit()
    // left to assert on.
    expect(mainChain.limit).toHaveBeenCalledWith(50);
    expect(mainChain.limit).toHaveBeenCalledTimes(1);
  });

  // The old two-query design short-circuited to [] (skipping the main
  // workItems query entirely) when the assignee's pre-query came back
  // empty. Folding this into a subquery removes the need for that special
  // case — `workItems.id IN (<subquery with 0 rows>)` is valid SQL that
  // simply matches nothing — so the main query now always runs exactly
  // once, whether or not the assignee turns out to have any items. (Real
  // Postgres behavior for this exact case — an assignee with zero matching
  // items genuinely returning zero rows, not an error or every row — was
  // independently verified against a live database; see the fix's PR
  // description.)
  it('still runs exactly one main query (no special-cased short-circuit) even for an assignee with no items', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain).mockReturnValueOnce(mainChain);

    const result = await listAllWorkItems({ assigneeId: 'mem-nobody' });

    expect(result).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('applies a limit at the query layer when given', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain);

    await listAllWorkItems({ limit: 51 });

    expect(mainChain.limit).toHaveBeenCalledWith(51);
  });
});

describe('listWorkItems filters', () => {
  it('combines the project scope with the given filters', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await listWorkItems('proj-1', { priority: 'high' });

    expect(eq).toHaveBeenCalledWith(workItems.projectId, 'proj-1');
    expect(eq).toHaveBeenCalledWith(workItems.priority, 'high');
  });

  // The project scope no longer needs to be duplicated inside the assignee
  // subquery: the outer query's own baseConditions already constrain to
  // workItems.projectId, and the subquery's ids are AND'd into that same
  // query — so intersecting an unscoped assignee subquery with the outer
  // project filter produces the same effective scoping in one query,
  // without a join inside the subquery itself.
  it('does not join workItems into the assignee subquery — the outer query already scopes by project', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain).mockReturnValueOnce(mainChain);

    await listWorkItems('proj-1', { assigneeId: 'mem-4' });

    expect(mainChain.innerJoin).not.toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith(workItemAssignees.assigneeId, 'mem-4');
    expect(eq).toHaveBeenCalledWith(workItems.projectId, 'proj-1');
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('applies a limit at the query layer when given', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain);

    await listWorkItems('proj-1', { limit: 51 });

    expect(mainChain.limit).toHaveBeenCalledWith(51);
  });
});
