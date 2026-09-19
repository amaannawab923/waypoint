import { act, renderHook } from '@testing-library/react';
import type { JiraTicket } from '@/types/jira';
import { usePagedTickets } from './usePagedTickets';

function ticket(id: string): JiraTicket {
  return {
    id,
    key: `ENG-${id}`,
    projectKey: 'ENG',
    title: `Ticket ${id}`,
    role: 'assignee',
    stateName: 'To Do',
    stateColor: 'var(--text-muted)',
    priority: 'none',
    priorityId: null,
    priorityName: 'None',
    assigneeName: 'Max Chen',
    assigneeAccountId: '5f8a',
    reporterName: 'Sam Lee',
    description: '',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    updatedAt: '2026-09-01T10:00:00.000Z',
    labels: [],
    dueDate: null,
    subtasks: [],
    links: [],
    descriptionAdf: null,
    attachments: [],
    isTombstoned: false,
    tombstone: null,
    hasConflict: false,
    conflict: null,
  };
}

function tickets(count: number): JiraTicket[] {
  return Array.from({ length: count }, (_, i) => ticket(String(i + 1)));
}

describe('usePagedTickets', () => {
  // Every test below hoists its ticket array to a variable BEFORE calling
  // renderHook, deliberately: `renderHook(() => usePagedTickets(tickets(N), 25))`
  // — calling the array factory inline — recreates a brand-new array on
  // every internal re-render, including the one usePagedTickets' own
  // setSeenTickets/setPage causes. Since the hook resets to page 1 whenever
  // the array reference changes, that is not a fresh read landing, it is a
  // NEW ARRAY EVERY RENDER — which resets page every render, which renders
  // again, forever. Caught by this suite's own "advances to the requested
  // page" test the first time it was written this way. A stable reference
  // is the same contract production code already satisfies: RoleTicketsTab
  // et al. pass `tickets`, a useState value that only changes when the
  // component itself calls setTickets.
  it('returns everything on one page when it fits within the page size', () => {
    const items = tickets(10);
    const { result } = renderHook(() => usePagedTickets(items, 25));

    expect(result.current.pageItems).toHaveLength(10);
    expect(result.current.pageCount).toBe(1);
    expect(result.current.rangeStart).toBe(1);
    expect(result.current.rangeEnd).toBe(10);
    expect(result.current.total).toBe(10);
  });

  it('splits a set larger than the page size across multiple pages', () => {
    const items = tickets(60);
    const { result } = renderHook(() => usePagedTickets(items, 25));

    expect(result.current.pageItems).toHaveLength(25);
    expect(result.current.pageCount).toBe(3);
    expect(result.current.pageItems[0].id).toBe('1');
    expect(result.current.pageItems[24].id).toBe('25');
  });

  it('advances to the requested page', () => {
    const items = tickets(60);
    const { result } = renderHook(() => usePagedTickets(items, 25));

    act(() => result.current.setPage(2));

    expect(result.current.page).toBe(2);
    expect(result.current.pageItems).toHaveLength(25);
    expect(result.current.pageItems[0].id).toBe('26');
    expect(result.current.rangeStart).toBe(26);
    expect(result.current.rangeEnd).toBe(50);
  });

  it('clamps a page beyond the last one instead of returning nothing', () => {
    const { result, rerender } = renderHook(
      ({ items }) => usePagedTickets(items, 25),
      { initialProps: { items: tickets(60) } },
    );
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);

    // The set shrinks out from under an unchanged page number — e.g. a
    // fresh read of the same role returning fewer results. This is a
    // genuinely different array, so it also exercises the reset-to-1 path
    // below in the same assertion.
    rerender({ items: tickets(5) });

    expect(result.current.page).toBe(1);
    expect(result.current.pageCount).toBe(1);
    expect(result.current.pageItems).toHaveLength(5);
  });

  it('resets to page 1 when the underlying ticket array changes, even at the same length', () => {
    const { result, rerender } = renderHook(
      ({ items }) => usePagedTickets(items, 25),
      { initialProps: { items: tickets(60) } },
    );
    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);

    // A genuinely new array (e.g. a role switch's fresh read) — even one
    // that happens to be the same length as the old one — must not leave
    // the reader stranded on a page number from a different query.
    rerender({ items: tickets(60) });

    expect(result.current.page).toBe(1);
  });

  it('does not reset the page on a re-render with the same array reference', () => {
    const items = tickets(60);
    const { result, rerender } = renderHook(() => usePagedTickets(items, 25));
    act(() => result.current.setPage(2));

    rerender();

    expect(result.current.page).toBe(2);
  });
});
