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
