import { useMemo, useState } from 'react';
import type { JiraTicket } from '@/types/jira';

// The per-role/per-source tabs' own pagination — deliberately its own small
// hook rather than a reuse of useMyJiraQueue, which is the All Tickets tab's
// search/sort/project/role-filter/pagination hook built around one specific
// thing: a module-level `lastQuery` that survives a remount so a filter
// isn't lost when the drawer's Expand navigates away and back. Sharing that
// hook across seven differently-scoped tabs would mean seven tabs fighting
// over ONE remembered query, each overwriting what the others last set —
// exactly the kind of cross-tab bleed a person switching between Assigned
// and Watching would notice immediately as "my page reset for no reason" or
// worse, "my filter followed me somewhere I didn't ask it to". These tabs
// only ever need pagination, not a query to remember, so this hook is only
// that.
export const TAB_PAGE_SIZE = 25;

export interface PagedTickets {
  pageItems: JiraTicket[];
  page: number;
  pageCount: number;
  /** 1-based inclusive range of `tickets` on this page, for "Showing X–Y of N". */
  rangeStart: number;
  rangeEnd: number;
  total: number;
  setPage: (page: number) => void;
}

export function usePagedTickets(
  tickets: JiraTicket[],
  pageSize: number = TAB_PAGE_SIZE,
): PagedTickets {
  const [page, setPage] = useState(1);
  // Resets to page 1 the moment the underlying array is a new one — a role
  // switch, a search, a fresh read landing. Comparing by reference (not
  // length or content) during render, React's own sanctioned pattern for
  // "derive state from a changed prop": this re-renders once, immediately,
  // before anything paints, rather than through a `useEffect` that would let
  // a stale page number's "No tickets" briefly show first.
  const [seenTickets, setSeenTickets] = useState(tickets);
  if (tickets !== seenTickets) {
    setSeenTickets(tickets);
    if (page !== 1) setPage(1);
  }

  const pageCount = Math.max(1, Math.ceil(tickets.length / pageSize));
  // Clamped, not trusted raw — the same reason useMyJiraQueue's own `page`
  // is: the set can shrink out from under an unchanged page number (fewer
  // results on a fresh read of the same role).
  const clampedPage = Math.min(Math.max(page, 1), pageCount);

  const pageItems = useMemo(
    () => tickets.slice((clampedPage - 1) * pageSize, clampedPage * pageSize),
    [tickets, clampedPage, pageSize],
  );

  return {
    pageItems,
    page: clampedPage,
    pageCount,
    rangeStart: tickets.length === 0 ? 0 : (clampedPage - 1) * pageSize + 1,
    rangeEnd: Math.min(clampedPage * pageSize, tickets.length),
    total: tickets.length,
    setPage,
  };
}
