import { act, renderHook, waitFor } from '@testing-library/react';
import {
  listTickets,
  listAllTickets,
  listStates,
  listLabels,
  listWorkstreams,
  listAllWorkstreams,
  listSprints,
  listAllSprints,
  listProjects,
} from '@/data/api';
import type { Project, Ticket, TicketState } from '@/types/entities';
import { hasActiveFilters, useTicketsView } from './useTicketsView';

// W5.2's own accept-criterion coverage for the hook half of the unified
// TicketList: project scope and workspace scope are the exact same hook
// with a different default filter (not two implementations), and the
// server-side-filtered `items` array is the one and only source the
// component's count line and its rendered rows both read from.
jest.mock('@/data/api', () => ({
  listTickets: jest.fn(),
  listAllTickets: jest.fn(),
  listStates: jest.fn(),
  listLabels: jest.fn(),
  listWorkstreams: jest.fn(),
  listAllWorkstreams: jest.fn(),
  listSprints: jest.fn(),
  listAllSprints: jest.fn(),
  listProjects: jest.fn(),
}));

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'wi-1',
    projectId: 'proj-1',
    identifier: 'CW-1',
    sequenceId: 1,
    title: 'Fix the thing',
    description: '',
    stateId: 'st-1',
    priority: 'medium',
    source: 'manual',
    assigneeIds: [],
    labelIds: [],
    workstreamId: null,
    sprintId: null,
    parentId: null,
    estimatePoints: null,
    estimateValue: null,
    startDate: null,
    dueDate: null,
    createdById: 'mem-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    attachmentCount: 0,
    linkCount: 0,
    links: [],
    isDraft: false,
    ...overrides,
  };
}

function state(overrides: Partial<TicketState> = {}): TicketState {
  return {
    id: 'st-1',
    projectId: 'proj-1',
    name: 'Todo',
    group: 'unstarted',
    color: '#888',
    isDefault: true,
    sortOrder: 0,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return { id: 'proj-1', name: 'Compass Web', icon: '🧭', ...overrides } as Project;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Per-project-distinct, like real state rows (project-owned, never shared
  // across projects) — a shared mock resolved value here would silently
  // double-count 'state'-grouped totals across the bounded-per-project
  // Promise.all fetch (see useTicketsView.ts's states/labels comment).
  jest.mocked(listStates).mockImplementation(async (projectId) => [state({ id: `st-${projectId}`, projectId })]);
  jest.mocked(listLabels).mockResolvedValue([]);
  jest.mocked(listWorkstreams).mockResolvedValue([]);
  jest.mocked(listAllWorkstreams).mockResolvedValue([]);
  jest.mocked(listSprints).mockResolvedValue([]);
  jest.mocked(listAllSprints).mockResolvedValue([]);
  jest.mocked(listProjects).mockResolvedValue([project()]);
  jest.mocked(listTickets).mockResolvedValue([ticket()]);
  jest.mocked(listAllTickets).mockResolvedValue([ticket(), ticket({ id: 'wi-2', projectId: 'proj-2', identifier: 'PL-1' })]);
});

describe('useTicketsView scope selection', () => {
  it('fetches via listTickets(projectId, ...) in project scope, never listAllTickets', async () => {
    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(listTickets).toHaveBeenCalledWith('proj-1', undefined);
    expect(listAllTickets).not.toHaveBeenCalled();
  });

  it('fetches via listAllTickets(...) in workspace scope (no projectId), never listTickets', async () => {
    const { result } = renderHook(() => useTicketsView({}));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(listAllTickets).toHaveBeenCalledWith(undefined);
    expect(listTickets).not.toHaveBeenCalled();
  });

  it('is the same hook in both scopes — only the default filter and the fetch target differ', async () => {
    const project1 = renderHook(() => useTicketsView({ projectId: 'proj-1' }));
    const workspace = renderHook(() =>
      useTicketsView({ defaultFilters: { assigneeId: ['@me'] } }),
    );
    await waitFor(() => expect(project1.result.current.loading).toBe(false));
    await waitFor(() => expect(workspace.result.current.loading).toBe(false));

    // Same shape, same function identity for every capability — grouping,
    // filtering, search, bulk all read/write through identical fields.
    expect(Object.keys(project1.result.current).sort()).toEqual(Object.keys(workspace.result.current).sort());
    expect(listAllTickets).toHaveBeenCalledWith({ v: 1, assigneeIds: ['@me'] });
  });

  it('seeds defaultFilters once on mount (YourWork Created tab: creatorId @me)', async () => {
    const { result } = renderHook(() =>
      useTicketsView({ defaultFilters: { creatorId: ['@me'] } }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.filters.creatorId).toEqual(['@me']);
    expect(listAllTickets).toHaveBeenCalledWith({ v: 1, creatorIds: ['@me'] });
  });
});

describe('useTicketsView filter query encoding', () => {
  it('encodes a free-text search into the typed filter`s `text` field, trimmed', async () => {
    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setFilters((f) => ({ ...f, text: '  race condition  ' }));
    });

    await waitFor(() =>
      expect(listTickets).toHaveBeenCalledWith('proj-1', { v: 1, text: 'race condition' }),
    );
  });

  it('omits an empty/whitespace-only search rather than sending an empty text filter', async () => {
    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setFilters((f) => ({ ...f, text: '   ' }));
    });

    // No call to listTickets ever carries a text filter — whitespace-only
    // text never round-trips into the query. Checked across every call
    // (not just the last one) because this hook also fires an unrelated,
    // always-unfiltered `listTickets(projectId)` call on mount (for true
    // sub-item totals — see useTicketsView's `unfilteredItems`), which can
    // legitimately be the most recent call recorded here.
    await waitFor(() => {
      expect(
        jest.mocked(listTickets).mock.calls.every(([, filter]) => filter === undefined),
      ).toBe(true);
    });
  });
});

describe('useTicketsView seeded-scope filters (clear filters must not wipe a view\'s default scope)', () => {
  it('resetFilters restores defaultFilters, not a bare empty state', async () => {
    const { result } = renderHook(() =>
      useTicketsView({ defaultFilters: { assigneeId: ['@me'] } }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setFilters((f) => ({ ...f, priority: ['urgent'] }));
    });
    await waitFor(() => expect(result.current.filters.priority).toEqual(['urgent']));

    act(() => {
      result.current.resetFilters();
    });

    // The seeded "assigned to me" scope survives Clear filters — only the
    // extra priority filter the user layered on top is dropped.
    expect(result.current.filters.assigneeId).toEqual(['@me']);
    expect(result.current.filters.priority).toEqual([]);
  });

  it('hasActiveFilters ignores a seeded defaultFilters baseline when nothing extra is set', async () => {
    const { result } = renderHook(() =>
      useTicketsView({ defaultFilters: { assigneeId: ['@me'] } }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Untouched — filters still equal the view's own seeded baseline.
    expect(hasActiveFilters(result.current.filters, result.current.defaultFilters)).toBe(false);

    act(() => {
      result.current.setFilters((f) => ({ ...f, priority: ['urgent'] }));
    });
    await waitFor(() => expect(result.current.filters.priority).toEqual(['urgent']));

    // Now something's genuinely been added on top of the baseline.
    expect(hasActiveFilters(result.current.filters, result.current.defaultFilters)).toBe(true);
  });
});

describe('useTicketsView subItemCountByParent (true totals regardless of the active filter)', () => {
  it("keeps a parent's true total/done sub-item counts even when the active filter narrows `items`", async () => {
    jest.mocked(listStates).mockResolvedValue([
      state({ id: 'st-1', group: 'unstarted' }),
      state({ id: 'st-done', group: 'completed' }),
    ]);

    const parent = ticket({ id: 'parent', stateId: 'st-1' });
    const doneChild = ticket({ id: 'child-done', parentId: 'parent', stateId: 'st-done', priority: 'low' });
    const urgentChild = ticket({ id: 'child-urgent', parentId: 'parent', stateId: 'st-1', priority: 'urgent' });
    const all = [parent, doneChild, urgentChild];

    // Simulates real server-side filtering (§4.6): an unfiltered fetch
    // (no second arg) returns everything; a priority-filtered fetch
    // returns only the matching subset.
    jest.mocked(listTickets).mockImplementation(async (_projectId, filter) => {
      if (!filter?.priorities) return all;
      return all.filter((t) => filter.priorities?.includes(t.priority));
    });

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setFilters((f) => ({ ...f, priority: ['urgent'] }));
    });

    // The filtered `items`/`allItems` only contains the urgent child...
    await waitFor(() => expect(result.current.items).toEqual([urgentChild]));

    // ...but the parent's sub-item badge must still reflect BOTH children,
    // not just the one that happens to match the active filter.
    expect(result.current.subItemCountByParent.get('parent')).toEqual({ total: 2, done: 1 });
  });
});

describe('useTicketsView parentById (finding 2c)', () => {
  it("maps a child ticket's id to its parent ticket, regardless of the active filter", async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1', priority: 'low' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent', priority: 'urgent' });
    const all = [parent, child];

    jest.mocked(listTickets).mockImplementation(async (_projectId, filter) => {
      if (!filter?.priorities) return all;
      return all.filter((t) => filter.priorities?.includes(t.priority));
    });

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // `child.parentId` is a hardcoded constant on this fixture (always
    // 'parent'), so a ternary keyed on it here was always-true dead weight —
    // assert the resolved value directly instead.
    expect(result.current.parentById.get('child')).toEqual(parent);
    expect(result.current.parentById.get('child')?.identifier).toBe('CW-1');

    act(() => {
      result.current.setFilters((f) => ({ ...f, priority: ['urgent'] }));
    });
    // The filtered `items` no longer includes the parent...
    await waitFor(() => expect(result.current.items).toEqual([child]));
    // ...but parentById still resolves it, since it's sourced from the
    // unfiltered dataset, same as subItemCountByParent.
    expect(result.current.parentById.get('child')?.identifier).toBe('CW-1');
  });

  it('has no entry for a parentless ticket', async () => {
    jest.mocked(listTickets).mockResolvedValue([ticket({ id: 'a', parentId: null })]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.parentById.has('a')).toBe(false);
  });
});

describe('useTicketsView same-group parent/child nesting (finding 2e)', () => {
  it('sorts a child to sit directly after its parent when they share a group, upstream of groupedItems', async () => {
    // Both land in the same 'st-proj-1' state group (per the per-project
    // listStates mock in beforeEach) — parent listed first in raw fetch
    // order, with an unrelated ticket sitting between them.
    const parent = ticket({ id: 'parent', identifier: 'CW-1', stateId: 'st-proj-1' });
    const unrelated = ticket({ id: 'unrelated', identifier: 'CW-2', stateId: 'st-proj-1' });
    const child = ticket({ id: 'child', identifier: 'CW-3', parentId: 'parent', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([parent, unrelated, child]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The critical assertion: `items` itself (not just groupedItems) is
    // reordered — reorderItemLocally computes drag-drop insertion against
    // this SAME array, so both must read the same order by construction.
    expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child', 'unrelated']);
    expect(result.current.nestedChildIds.has('child')).toBe(true);

    const group = result.current.groupedItems.find((g) => g.key === 'st-proj-1');
    expect(group?.items.map((i) => i.id)).toEqual(['parent', 'child', 'unrelated']);
  });

  it('does NOT nest a child under its parent when they land in different groups', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1', priority: 'low' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent', priority: 'urgent' });
    jest.mocked(listTickets).mockResolvedValue([parent, child]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'priority' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.nestedChildIds.has('child')).toBe(false);
    // Untouched order — 2c's parent chip does the pointing here instead.
    expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child']);
  });

  // Manual QA per the proposal's own risk note: a real drag-drop of a Board
  // card was checked by hand against the running app (a parent/child pair
  // in the same board column, dropped elsewhere in that column, landed
  // exactly where dropped). This is the automated companion — it exercises
  // reorderItemLocally (what a real card drop calls) directly against a
  // same-group parent/child pair, and asserts `items` and `groupedItems`
  // still agree afterward, i.e. no reconciliation gap between what the
  // resort produced and what a drag-drop mutates.
  it('reorderItemLocally still agrees with the nested render order after a drag-drop-style move', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1', stateId: 'st-proj-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent', stateId: 'st-proj-1' });
    const other = ticket({ id: 'other', identifier: 'CW-3', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([parent, child, other]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Pre-drag: parent, child (nested right after it), other.
    expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child', 'other']);

    // Simulate dragging "other" to drop directly after "child" — exactly
    // what BoardView's handleCardDrop calls with the ids/position it read
    // off the rendered (nested) DOM.
    act(() => {
      result.current.reorderItemLocally('other', 'child', 'after');
    });

    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child', 'other']));
    const group = result.current.groupedItems.find((g) => g.key === 'st-proj-1');
    expect(group?.items.map((i) => i.id)).toEqual(result.current.items.map((i) => i.id));
  });

  it("nests every parent/child pair when groupBy is 'none' (a single group)", async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1' });
    const unrelated = ticket({ id: 'unrelated', identifier: 'CW-2' });
    const child = ticket({ id: 'child', identifier: 'CW-3', parentId: 'parent' });
    jest.mocked(listTickets).mockResolvedValue([parent, unrelated, child]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'none' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child', 'unrelated']);
  });

  // H3: the pre-existing regression test for reorderItemLocally moved an
  // item to a position it was already in ('other' dropped 'after' 'child',
  // when 'other' was already right after 'child') — "nothing changed"
  // passes trivially under a wide range of broken implementations. This is
  // the real 'before' case: dropping "other" directly BEFORE "child" asks
  // to insert it between "child" and its nesting parent "parent". Per H2's
  // documented (not silently left implicit) decision, that's a known no-op
  // at the rendered-order level — reorderItemLocally mutates the RAW list
  // (parent, other, child after this call), but the same-group nesting
  // resort always re-splices "child" directly after "parent" regardless, so
  // `items` renders identically to how it did before the call. BoardView's
  // onDragOver suppresses the drag-over indicator (and refuses the drop)
  // for exactly this boundary so a user is never invited to drop there in
  // the first place — this test covers the hook-level mechanism that
  // suppression exists to route around.
  it("reorderItemLocally dropping 'before' an already-adjacent nested child is a documented no-op in the rendered order", async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1', stateId: 'st-proj-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent', stateId: 'st-proj-1' });
    const other = ticket({ id: 'other', identifier: 'CW-3', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([parent, child, other]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child', 'other']);

    act(() => {
      result.current.reorderItemLocally('other', 'child', 'before');
    });

    // The rendered order is unchanged — "other" never visibly lands between
    // "parent" and "child", because the nesting resort always re-splices
    // "child" directly after "parent" no matter where the raw list now
    // holds "other".
    await waitFor(() =>
      expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child', 'other']),
    );
    const group = result.current.groupedItems.find((g) => g.key === 'st-proj-1');
    expect(group?.items.map((i) => i.id)).toEqual(result.current.items.map((i) => i.id));
  });
});

// B1 (blocking): the nesting logic used to splice children under their
// parent only one level deep, so a grandchild (created via this PR's own
// "Add subtask" flow, two levels in) was marked "nested" — and therefore
// skipped in the main splice pass — but never spliced in anywhere, since
// only a top-level item's own DIRECT children were appended. It silently
// vanished from `items`, which feeds List, Board, and Spreadsheet alike, so
// there was no view left that showed it. A parent-chain cycle (A.parent=B,
// B.parent=A, or a self-parented ticket) was worse: every ticket in the
// cycle marked itself "nested" and none of them were ever visited at the
// top level, so `orderedItems` came out empty.
describe('useTicketsView B1: deep nesting and cycle safety (no ticket may ever be dropped)', () => {
  it('never drops a ticket from orderedItems — orderedItems.length === resolvedItems.length always', async () => {
    // A mix of a 3-level chain, an unrelated ticket, and a 2-cycle, all in
    // the same group — exactly the shape that used to lose tickets.
    const a = ticket({ id: 'a', identifier: 'CW-1', stateId: 'st-proj-1' });
    const b = ticket({ id: 'b', identifier: 'CW-2', parentId: 'a', stateId: 'st-proj-1' });
    const c = ticket({ id: 'c', identifier: 'CW-3', parentId: 'b', stateId: 'st-proj-1' });
    const unrelated = ticket({ id: 'unrelated', identifier: 'CW-4', stateId: 'st-proj-1' });
    const cycleX = ticket({ id: 'cycle-x', identifier: 'CW-5', parentId: 'cycle-y', stateId: 'st-proj-1' });
    const cycleY = ticket({ id: 'cycle-y', identifier: 'CW-6', parentId: 'cycle-x', stateId: 'st-proj-1' });
    const fixture = [a, b, c, unrelated, cycleX, cycleY];
    jest.mocked(listTickets).mockResolvedValue(fixture);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toHaveLength(fixture.length);
    expect(new Set(result.current.items.map((i) => i.id))).toEqual(
      new Set(fixture.map((i) => i.id)),
    );
  });

  it('nests a 3-level chain (A→B→C, same group) in order, with all three present', async () => {
    const a = ticket({ id: 'a', identifier: 'CW-1', stateId: 'st-proj-1' });
    const b = ticket({ id: 'b', identifier: 'CW-2', parentId: 'a', stateId: 'st-proj-1' });
    const c = ticket({ id: 'c', identifier: 'CW-3', parentId: 'b', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([a, b, c]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // All three present, nested in the correct depth-first order: A, then
    // its child B directly after it, then B's own child C directly after B.
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.nestedChildIds.has('b')).toBe(true);
    expect(result.current.nestedChildIds.has('c')).toBe(true);

    const group = result.current.groupedItems.find((g) => g.key === 'st-proj-1');
    expect(group?.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats a 2-ticket parent cycle (A.parent=B, B.parent=A) as top-level rather than dropping both', async () => {
    const a = ticket({ id: 'a', identifier: 'CW-1', parentId: 'b', stateId: 'st-proj-1' });
    const b = ticket({ id: 'b', identifier: 'CW-2', parentId: 'a', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([a, b]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Neither ticket vanishes — both render, un-nested (the cycle guard
    // excludes both from ever being treated as a nested child).
    expect(result.current.items).toHaveLength(2);
    expect(new Set(result.current.items.map((i) => i.id))).toEqual(new Set(['a', 'b']));
    expect(result.current.nestedChildIds.has('a')).toBe(false);
    expect(result.current.nestedChildIds.has('b')).toBe(false);
  });

  it('treats a self-parented ticket the same way — top-level, not dropped', async () => {
    const selfParented = ticket({ id: 'a', identifier: 'CW-1', parentId: 'a', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([selfParented]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items.map((i) => i.id)).toEqual(['a']);
    expect(result.current.nestedChildIds.has('a')).toBe(false);
  });
});

describe('useTicketsView groupedItems totals the same as items (count-line invariant)', () => {
  // stateId matches the per-project state id the listStates mock above
  // generates (`st-${projectId}`) so 'state' grouping has somewhere real
  // to place every ticket, the same way it would with real per-project data.
  const fixture = [
    ticket({ id: 'a', stateId: 'st-proj-1', priority: 'urgent', assigneeIds: ['mem-1'] }),
    ticket({ id: 'b', stateId: 'st-proj-1', priority: 'low', assigneeIds: [] }),
    ticket({ id: 'c', projectId: 'proj-2', stateId: 'st-proj-2', priority: 'none', assigneeIds: [] }),
  ];

  it.each(['state', 'priority', 'assignee', 'project', 'none'] as const)(
    "sums to exactly items.length when grouped by '%s'",
    async (groupBy) => {
      jest.mocked(listAllTickets).mockResolvedValue(fixture);
      const { result } = renderHook(() => useTicketsView({ defaultGroupBy: groupBy }));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const total = result.current.groupedItems.reduce((n, g) => n + g.items.length, 0);
      expect(total).toBe(result.current.items.length);
      expect(result.current.items.length).toBe(fixture.length);
    },
  );
});

// ROAD-39: collapsible parent/child hierarchy. `collapsedParents` and
// `toggleParentCollapsed` are session-only, in-memory, default-expanded —
// nothing is collapsed until the user acts, and nothing here is persisted.
// The filter runs upstream of both `items`/`orderedItems` AND
// `groupedItems` (the same array BoardView's drag-reorder math reads via
// `view.items`), so a collapsed subtree is genuinely absent from every
// consumer of this hook, not merely hidden by a display-layer filter the
// reorder math can't see.
describe('useTicketsView collapsedParents (ROAD-39: collapsible hierarchy)', () => {
  it('defaults to fully expanded — collapsedParents starts empty and nothing is hidden', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1', stateId: 'st-proj-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([parent, child]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.collapsedParents.size).toBe(0);
    expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child']);
  });

  it('toggleParentCollapsed removes the whole subtree from items (and groupedItems) — not merely a visual hide', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1', stateId: 'st-proj-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent', stateId: 'st-proj-1' });
    const other = ticket({ id: 'other', identifier: 'CW-3', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([parent, child, other]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child', 'other']);

    act(() => {
      result.current.toggleParentCollapsed('parent');
    });

    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'other']));
    expect(result.current.collapsedParents.has('parent')).toBe(true);
    const group = result.current.groupedItems.find((g) => g.key === 'st-proj-1');
    expect(group?.items.map((i) => i.id)).toEqual(['parent', 'other']);
  });

  it('toggling a second time re-expands, restoring the subtree', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1', stateId: 'st-proj-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([parent, child]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.toggleParentCollapsed('parent');
    });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['parent']));

    act(() => {
      result.current.toggleParentCollapsed('parent');
    });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['parent', 'child']));
    expect(result.current.collapsedParents.has('parent')).toBe(false);
  });

  it('collapses a 3-level chain (A→B→C) entirely from the top, not one level at a time', async () => {
    const a = ticket({ id: 'a', identifier: 'CW-1', stateId: 'st-proj-1' });
    const b = ticket({ id: 'b', identifier: 'CW-2', parentId: 'a', stateId: 'st-proj-1' });
    const c = ticket({ id: 'c', identifier: 'CW-3', parentId: 'b', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([a, b, c]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);

    act(() => {
      result.current.toggleParentCollapsed('a');
    });

    // Both B and C vanish in one toggle — collapsing hides the whole
    // subtree at once, not one level at a time (appendDescendants already
    // splices arbitrarily-deep chains into one contiguous run; this is the
    // hiding side of that same mechanism).
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['a']));
  });

  it('does not affect subItemCountByParent — the Epic badge stays accurate (true total) while collapsed', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1', stateId: 'st-proj-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent', stateId: 'st-proj-1' });
    jest.mocked(listTickets).mockResolvedValue([parent, child]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'state' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.toggleParentCollapsed('parent');
    });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['parent']));

    // subItemCountByParent is built from `unfilteredItems`, independent of
    // both the active filter AND (now) collapse state — the badge's
    // "N/M" must not go stale just because the subtree is hidden.
    expect(result.current.subItemCountByParent.get('parent')).toEqual({ total: 1, done: 0 });
  });

  it('collapsing a parent whose children are NOT nested (different group) hides nothing — inherited from the same-group nesting rule', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1', priority: 'low' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent', priority: 'urgent' });
    jest.mocked(listTickets).mockResolvedValue([parent, child]);

    const { result } = renderHook(() => useTicketsView({ projectId: 'proj-1', defaultGroupBy: 'priority' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.nestedChildIds.has('child')).toBe(false);

    act(() => {
      result.current.toggleParentCollapsed('parent');
    });

    // Nothing to hide — the child never rendered adjacent to the parent in
    // the first place (finding 2e's parent chip points at it from its own
    // group instead), so toggling collapse is a documented no-op here.
    await waitFor(() => expect(result.current.collapsedParents.has('parent')).toBe(true));
    expect(result.current.items.map((i) => i.id).sort()).toEqual(['child', 'parent']);
  });
});
