import { useEffect, useState } from 'react';
import { LIST_BY_KEYS_MAX, listTicketsByJiraKeys } from '@/data/jiraApi';
import { useAsync } from '@/lib/useAsync';
import { useJiraStarredKeys } from '@/lib/jiraStarred';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { JiraTicketRow } from '@/components/domain/JiraTicketRow';
import { JiraTicketDrawer } from '@/components/domain/JiraTicketDrawer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraTicket } from '@/types/jira';
import { usePagedTickets } from './usePagedTickets';
import JiraTicketPager from './JiraTicketPager';

/**
 * Starred: this device's own pinned set (jiraStarred.ts — local-only,
 * doesn't survive a reinstall, the founder's own call over Jira issue
 * properties). Re-resolves through listTicketsByJiraKeys (ROAD-158's bulk
 * by-key read) the moment the starred key set itself changes — starring or
 * unstarring a ticket from its own drawer updates this tab immediately, not
 * only on next mount, since useJiraStarredKeys is a live subscription.
 *
 * Unstarring a row itself still only happens from the ticket's own drawer
 * for now — an inline star button on every row is JiraTicketRow's own
 * layout to add (ROAD-158's later row-redesign phase), not something this
 * tab reaches in and bolts on for itself.
 */
export default function StarredTab({
  onCountChange,
}: {
  /** Reports the live tickets count up to the page's own tab label — see
   * MyJiraPage.tsx's TAB_COUNTS state and RoleTicketsTab's identical prop. */
  onCountChange?: (count: number) => void;
} = {}) {
  const starredKeys = useJiraStarredKeys();
  // Found in review: listTicketsByJiraKeys silently caps at
  // LIST_BY_KEYS_MAX — past that many stars, the pager's own "of N" was the
  // only number on screen, and it counted the tickets that LOADED, not the
  // tickets actually starred. Someone who starred 80 tickets saw "Showing
  // 1–25 of 50" with nothing saying 30 of their own stars weren't there.
  const keysTruncated = starredKeys.length > LIST_BY_KEYS_MAX;

  const {
    data: fetchedTickets,
    loading,
    error,
    reload,
  } = useAsync(
    // Skipped here, not just inside listTicketsByJiraKeys' own short-circuit
    // — nothing starred is this tab's single most common state (a brand new
    // install starts here), and there is no reason to cross the IPC
    // boundary at all to learn what an empty array already tells us.
    () =>
      starredKeys.length === 0
        ? Promise.resolve([])
        : listTicketsByJiraKeys(starredKeys),
    [starredKeys],
  );

  const [tickets, setTickets] = useState<JiraTicket[]>([]);
  useEffect(() => {
    if (fetchedTickets) setTickets(fetchedTickets);
  }, [fetchedTickets]);
  useEffect(() => {
    onCountChange?.(tickets.length);
    // onCountChange intentionally omitted — see RoleTicketsTab's identical
    // effect for why.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets]);

  // Snapshotted once, at open time — deliberately NOT derived from `tickets`
  // on every render (`tickets.find(t => t.id === drawerTicketId)`, this
  // tab's own earlier approach). Unstarring is an action taken FROM inside
  // this exact drawer: it changes `starredKeys`, which re-runs the
  // useAsync fetch above with the ticket's own key now missing, which
  // replaces `tickets` without it — and a derived lookup would go straight
  // to null the instant that refetch lands, unmounting the drawer the user
  // is actively looking at out from under them. This still updates for a
  // genuine field edit (updateTicket, e.g. a state/priority/comment
  // change), just never because the SET OF STARRED KEYS changed. Doubles
  // as "is the drawer open" — no separate id needed alongside it.
  const [drawerTicket, setDrawerTicket] = useState<JiraTicket | null>(null);

  function updateTicket(updated: JiraTicket) {
    setTickets((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    setDrawerTicket((prev) =>
      prev && prev.id === updated.id ? updated : prev,
    );
  }

  const paged = usePagedTickets(tickets);

  function openDrawer(id: string) {
    // The id always comes from a currently-rendered row, i.e. from this
    // same `tickets` array — the lookup can't miss.
    const found = tickets.find((t) => t.id === id);
    if (found) setDrawerTicket(found);
  }

  // See RoleTicketsTab's own header for why these throw instead of
  // silently no-op: neither read this tab performs ever produces a
  // hasConflict/isTombstoned ticket, so JiraTicketRow should never call
  // either.
  async function neverResolvesConflict(): Promise<void> {
    throw new Error('StarredTab: hasConflict is always false here');
  }
  async function neverDismissesTombstone(): Promise<void> {
    throw new Error('StarredTab: isTombstoned is always false here');
  }

  return (
    <div>
      {keysTruncated && (
        <div className="mb-3 rounded-[var(--radius-sm)] border border-warning/30 bg-warning-bg px-3 py-2 text-[11.5px] leading-relaxed text-warning">
          You&apos;ve starred {starredKeys.length} tickets — showing the{' '}
          {LIST_BY_KEYS_MAX} most recently starred.
        </div>
      )}

      <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface shadow-sm">
        {loading && tickets.length === 0 ? (
          <SkeletonListRows />
        ) : (
          <>
            {error && (
              <JiraLoadError
                what="your starred tickets"
                error={error}
                onRetry={reload}
              />
            )}
            {!error && tickets.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-text-muted">
                <p className="font-semibold text-text-secondary">
                  Nothing starred yet.
                </p>
                <p className="mt-1">
                  Open a ticket and star it to pin it here — kept on this device
                  only.
                </p>
              </div>
            )}
            {!error &&
              paged.pageItems.map((ticket) => (
                <JiraTicketRow
                  key={ticket.id}
                  ticket={ticket}
                  onOpenDrawer={openDrawer}
                  onTicketUpdated={updateTicket}
                  onResolveConflict={neverResolvesConflict}
                  onDismissTombstone={neverDismissesTombstone}
                />
              ))}
          </>
        )}
      </div>

      {!error && tickets.length > 0 && (
        <JiraTicketPager
          page={paged.page}
          pageCount={paged.pageCount}
          rangeStart={paged.rangeStart}
          rangeEnd={paged.rangeEnd}
          total={paged.total}
          onPageChange={paged.setPage}
        />
      )}

      {drawerTicket && (
        <JiraTicketDrawer
          ticket={drawerTicket}
          onTicketUpdated={updateTicket}
          onClose={() => setDrawerTicket(null)}
        />
      )}
    </div>
  );
}
