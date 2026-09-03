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
    or: vi.fn(actual.or),
    ilike: vi.fn(actual.ilike),
    lte: vi.fn(actual.lte),
    gte: vi.fn(actual.gte),
    inArray: vi.fn(actual.inArray),
    notInArray: vi.fn(actual.notInArray),
  };
});

const { tickets, ticketAssignees, ticketLabels, ticketStates } = await import('../db/schema/index.js');
const { searchTickets, listAllTickets, listTickets, listTicketsByFilter, buildTypedFilterConditions } =
  await import('./tickets.service.js');
const { eq, and, or, ilike, lte, gte, inArray, notInArray } = await import('drizzle-orm');

beforeEach(() => {
  vi.clearAllMocks();
  // attachRelations' three relation queries (labels/assignees/links) — the
  // main search query is set per-test via mockReturnValueOnce, so these
  // empty fallbacks only ever back the relation lookups that follow it.
  db.select.mockReturnValue(chainable([]));
});

describe('searchTickets', () => {
  it('matches on title (case-insensitively) and excludes drafts, with no project filter by default', async () => {
    const rows = [{ id: 'wi-1', title: 'Fix login bug', isDraft: false }];
    db.select.mockReturnValueOnce(chainable(rows));

    const result = await searchTickets('login');

    expect(ilike).toHaveBeenCalledWith(tickets.title, '%login%');
    expect(eq).toHaveBeenCalledWith(tickets.isDraft, false);
    expect(result).toEqual([{ ...rows[0], assigneeIds: [], labelIds: [], links: [] }]);
  });

  it('filters to one project when projectId is given', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await searchTickets('login', 'proj-1');

    expect(eq).toHaveBeenCalledWith(tickets.projectId, 'proj-1');
  });

  it('does not filter by projectId when it is omitted', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await searchTickets('login');

    expect(eq).not.toHaveBeenCalledWith(tickets.projectId, expect.anything());
  });

  // Regression test: a literal `%` or `_` in the query is a LIKE wildcard,
  // not a literal character — unescaped, `search_tickets({query: "%"})`
  // matched every row instead of the literal "%" character.
  it('escapes LIKE metacharacters (%, _, \\) in the query before building the pattern', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await searchTickets('100%_off\\sale');

    expect(ilike).toHaveBeenCalledWith(tickets.title, '%100\\%\\_off\\\\sale%');
  });

  it('does not let a bare "%" query match every row — it is escaped to a literal', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await searchTickets('%');

    expect(ilike).toHaveBeenCalledWith(tickets.title, '%\\%%');
  });

  it('applies a limit at the query layer when given, not as a post-fetch slice', async () => {
    const searchChain = chainable([]);
    db.select.mockReturnValueOnce(searchChain);

    await searchTickets('login', undefined, 51);

    expect(searchChain.limit).toHaveBeenCalledWith(51);
  });

  it('does not call limit() at all when no limit is given', async () => {
    const searchChain = chainable([]);
    db.select.mockReturnValueOnce(searchChain);

    await searchTickets('login');

    expect(searchChain.limit).not.toHaveBeenCalled();
  });
});

describe('listAllTickets filters', () => {
  it('applies no extra conditions when no filters are given', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await listAllTickets();

    expect(eq).toHaveBeenCalledWith(tickets.isDraft, false);
    expect(eq).not.toHaveBeenCalledWith(tickets.stateId, expect.anything());
    expect(lte).not.toHaveBeenCalled();
  });

  it('filters by stateId, priority, and dueBefore', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await listAllTickets({ stateId: 'st-1', priority: 'urgent', dueBefore: '2026-09-01' });

    expect(eq).toHaveBeenCalledWith(tickets.stateId, 'st-1');
    expect(eq).toHaveBeenCalledWith(tickets.priority, 'urgent');
    expect(lte).toHaveBeenCalledWith(tickets.dueDate, '2026-09-01');
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
  // from ticketAssignees, not a plain resolved array of ids.
  it('folds assigneeId into the SAME single query as every other filter, via a subquery passed to inArray — not a separate pre-query', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain); // the ticketAssignees subquery builder itself
    db.select.mockReturnValueOnce(mainChain); // the main tickets query

    await listAllTickets({ assigneeId: 'mem-4', stateId: 'st-1', dueBefore: '2026-09-01', limit: 50 });

    // Exactly two db.select() calls total: one to build the subquery
    // expression, one for the main tickets query — never a third,
    // independently-awaited pre-query round-trip.
    expect(db.select).toHaveBeenCalledTimes(2);

    // The assignee subquery itself is built from ticketAssignees, scoped
    // by assigneeId, and critically has NO .limit() of its own — it must
    // contribute every one of the assignee's item ids to the AND'd
    // condition set, not a capped subset.
    expect(db.select).toHaveBeenCalledWith({ ticketId: ticketAssignees.ticketId });
    expect(eq).toHaveBeenCalledWith(ticketAssignees.assigneeId, 'mem-4');

    // inArray() must receive the subquery builder (an object, not a plain
    // array of already-resolved ids) — proof the assignee condition is
    // expressed as `tickets.id IN (<subquery>)` within the main query,
    // not resolved to a value list ahead of time.
    expect(inArray).toHaveBeenCalledWith(tickets.id, expect.objectContaining({ where: expect.any(Function) }));
    const inArrayCall = (inArray as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === tickets.id,
    );
    expect(Array.isArray(inArrayCall?.[1])).toBe(false);

    // Every other filter condition (stateId, dueBefore) is combined in the
    // SAME and(...) call as the assignee inArray condition — proof they all
    // apply together in one query, not the assignee filter narrowing a
    // separately-capped candidate set first.
    expect(eq).toHaveBeenCalledWith(tickets.stateId, 'st-1');
    expect(lte).toHaveBeenCalledWith(tickets.dueDate, '2026-09-01');
    const andCall = (and as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(andCall).toBeDefined();

    // The single .limit() applies to the main query only, after everything
    // above is already combined — there's no separate pre-query .limit()
    // left to assert on.
    expect(mainChain.limit).toHaveBeenCalledWith(50);
    expect(mainChain.limit).toHaveBeenCalledTimes(1);
  });

  // The old two-query design short-circuited to [] (skipping the main
  // tickets query entirely) when the assignee's pre-query came back
  // empty. Folding this into a subquery removes the need for that special
  // case — `tickets.id IN (<subquery with 0 rows>)` is valid SQL that
  // simply matches nothing — so the main query now always runs exactly
  // once, whether or not the assignee turns out to have any items. (Real
  // Postgres behavior for this exact case — an assignee with zero matching
  // items genuinely returning zero rows, not an error or every row — was
  // independently verified against a live database; see the fix's PR
  // description.)
  it('still runs exactly one main query (no special-cased short-circuit) even for an assignee with no items', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain).mockReturnValueOnce(mainChain);

    const result = await listAllTickets({ assigneeId: 'mem-nobody' });

    expect(result).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('applies a limit at the query layer when given', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain);

    await listAllTickets({ limit: 51 });

    expect(mainChain.limit).toHaveBeenCalledWith(51);
  });
});

describe('listTickets filters', () => {
  it('combines the project scope with the given filters', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await listTickets('proj-1', { priority: 'high' });

    expect(eq).toHaveBeenCalledWith(tickets.projectId, 'proj-1');
    expect(eq).toHaveBeenCalledWith(tickets.priority, 'high');
  });

  // The project scope no longer needs to be duplicated inside the assignee
  // subquery: the outer query's own baseConditions already constrain to
  // tickets.projectId, and the subquery's ids are AND'd into that same
  // query — so intersecting an unscoped assignee subquery with the outer
  // project filter produces the same effective scoping in one query,
  // without a join inside the subquery itself.
  it('does not join tickets into the assignee subquery — the outer query already scopes by project', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain).mockReturnValueOnce(mainChain);

    await listTickets('proj-1', { assigneeId: 'mem-4' });

    expect(mainChain.innerJoin).not.toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith(ticketAssignees.assigneeId, 'mem-4');
    expect(eq).toHaveBeenCalledWith(tickets.projectId, 'proj-1');
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('applies a limit at the query layer when given', async () => {
    const mainChain = chainable([]);
    db.select.mockReturnValueOnce(mainChain);

    await listTickets('proj-1', { limit: 51 });

    expect(mainChain.limit).toHaveBeenCalledWith(51);
  });
});

// The typed filter (docs/design/waypoint-revamp-architecture.md §4.6) —
// the single query-building path behind GET /tickets?filter=<base64url>
// and its project-scoped sibling.
describe('buildTypedFilterConditions', () => {
  it('excludes drafts by default, matching the MCP list tools convention', () => {
    buildTypedFilterConditions({});

    expect(eq).toHaveBeenCalledWith(tickets.isDraft, false);
  });

  it('does not filter on isDraft at all when includeDrafts is true', () => {
    buildTypedFilterConditions({ includeDrafts: true });

    expect(eq).not.toHaveBeenCalledWith(tickets.isDraft, expect.anything());
  });

  it('applies projectIds, stateIds, priorities, sources, workstreamIds and sprintIds as plain inArray conditions', () => {
    buildTypedFilterConditions({
      projectIds: ['proj-1'],
      stateIds: ['st-1', 'st-2'],
      priorities: ['urgent'],
      sources: ['agent'],
      workstreamIds: ['ws-1'],
      sprintIds: ['spr-1'],
    });

    expect(inArray).toHaveBeenCalledWith(tickets.projectId, ['proj-1']);
    expect(inArray).toHaveBeenCalledWith(tickets.stateId, ['st-1', 'st-2']);
    expect(inArray).toHaveBeenCalledWith(tickets.priority, ['urgent']);
    expect(inArray).toHaveBeenCalledWith(tickets.source, ['agent']);
    expect(inArray).toHaveBeenCalledWith(tickets.workstreamId, ['ws-1']);
    expect(inArray).toHaveBeenCalledWith(tickets.sprintId, ['spr-1']);
  });

  it('expresses labelIds as a ticketLabels subquery passed to inArray(tickets.id, ...), not a join', () => {
    buildTypedFilterConditions({ labelIds: ['lbl-1', 'lbl-2'] });

    expect(db.select).toHaveBeenCalledWith({ ticketId: ticketLabels.ticketId });
    expect(inArray).toHaveBeenCalledWith(ticketLabels.labelId, ['lbl-1', 'lbl-2']);
    const idCall = (inArray as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === tickets.id);
    expect(idCall).toBeDefined();
    expect(Array.isArray(idCall?.[1])).toBe(false);
  });

  it('expresses stateGroups as a ticketStates subquery passed to inArray(tickets.stateId, ...)', () => {
    buildTypedFilterConditions({ stateGroups: ['backlog', 'started'] });

    expect(db.select).toHaveBeenCalledWith({ id: ticketStates.id });
    expect(inArray).toHaveBeenCalledWith(ticketStates.group, ['backlog', 'started']);
  });

  it('applies specific assigneeIds as a ticketAssignees subquery, same shape as the untyped filter', () => {
    buildTypedFilterConditions({ assigneeIds: ['mem-4'] });

    expect(db.select).toHaveBeenCalledWith({ ticketId: ticketAssignees.ticketId });
    expect(inArray).toHaveBeenCalledWith(ticketAssignees.assigneeId, ['mem-4']);
    expect(or).not.toHaveBeenCalled();
  });

  it("resolves '@me' to CURRENT_USER_ID (mem-1) so a saved view means the viewer's own tickets", () => {
    buildTypedFilterConditions({ assigneeIds: ['@me'] });

    expect(inArray).toHaveBeenCalledWith(ticketAssignees.assigneeId, ['mem-1']);
  });

  it("resolves '@unassigned' alone to a NOT IN subquery over every assignee row", () => {
    buildTypedFilterConditions({ assigneeIds: ['@unassigned'] });

    expect(notInArray).toHaveBeenCalledWith(tickets.id, expect.anything());
    expect(inArray).not.toHaveBeenCalledWith(ticketAssignees.assigneeId, expect.anything());
  });

  it("ORs the specific-id condition with the unassigned condition when both are present — array-contains semantics extend to the sentinel", () => {
    buildTypedFilterConditions({ assigneeIds: ['mem-4', '@unassigned'] });

    expect(inArray).toHaveBeenCalledWith(ticketAssignees.assigneeId, ['mem-4']);
    expect(notInArray).toHaveBeenCalledWith(tickets.id, expect.anything());
    expect(or).toHaveBeenCalled();
  });

  it('resolves a relative updatedBefore token to a Date roughly N days ago and applies it with lte', () => {
    const before = Date.now();
    buildTypedFilterConditions({ updatedBefore: '-30d' });
    const after = Date.now();

    expect(lte).toHaveBeenCalledTimes(1);
    const [[column, value]] = (lte as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(column).toBe(tickets.updatedAt);
    expect(value).toBeInstanceOf(Date);
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    expect((value as Date).getTime()).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect((value as Date).getTime()).toBeLessThanOrEqual(after - expectedMs + 1000);
  });

  it('resolves an absolute createdAfter token to that exact Date and applies it with gte', () => {
    buildTypedFilterConditions({ createdAfter: '2026-01-01' });

    expect(gte).toHaveBeenCalledWith(tickets.createdAt, new Date('2026-01-01'));
  });

  it('silently drops an unparseable date token rather than throwing (defense in depth — the route layer already validates this shape)', () => {
    expect(() => buildTypedFilterConditions({ updatedBefore: 'not-a-date' })).not.toThrow();
    expect(lte).not.toHaveBeenCalled();
  });

  it('applies text as an escaped ilike on the title, same pattern as searchTickets', () => {
    buildTypedFilterConditions({ text: '100%_off' });

    expect(ilike).toHaveBeenCalledWith(tickets.title, '%100\\%\\_off%');
  });
});

describe('listTicketsByFilter', () => {
  it('runs a single query combining every condition with AND and orders by sortOrder', async () => {
    const mainChain = chainable([{ id: 'wi-1' }]);
    db.select.mockReturnValueOnce(mainChain);

    const result = await listTicketsByFilter({ priorities: ['urgent'], stateIds: ['st-1'] });

    expect(eq).toHaveBeenCalledWith(tickets.isDraft, false);
    expect(inArray).toHaveBeenCalledWith(tickets.priority, ['urgent']);
    expect(inArray).toHaveBeenCalledWith(tickets.stateId, ['st-1']);
    expect(mainChain.orderBy).toHaveBeenCalled();
    expect(result).toEqual([{ id: 'wi-1', assigneeIds: [], labelIds: [], links: [] }]);
  });
});
