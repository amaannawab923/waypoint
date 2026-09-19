import { useEffect, useState } from 'react';
import { listPastJiraTickets } from '@/data/jiraApi';
import { useAsync } from '@/lib/useAsync';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { JiraTicketRow } from '@/components/domain/JiraTicketRow';
import { JiraTicketDrawer } from '@/components/domain/JiraTicketDrawer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraTicket } from '@/types/jira';
import { usePagedTickets } from './usePagedTickets';
import JiraTicketPager from './JiraTicketPager';

/**
 * My past tickets: issues real Jira history says were once assigned to this
 * account and no longer are (see jiraClient.ts's PAST_TICKETS_JQL) — real
 * tombstoning via Jira's own `WAS` operator, not the disappearance-guessing
 * toTicket's own isTombstoned field has always stayed false for.
 *
 * Self-contained like the other tabs. Not showing who reassigned it or when
 * yet — that needs one more read per matched ticket (the issue's own
 * changelog) to name, which this tab's own live-verification (this ticket's
 * conversation, and jiraClient.ts's PAST_TICKETS_JQL comment) explicitly
 * left for a follow-up: the query only finds which tickets qualify.
 */
export default function PastTicketsTab({
  onCountChange,
}: {
  /** Reports the live tickets count up to the page's own tab label — see
   * MyJiraPage.tsx's TAB_COUNTS state and RoleTicketsTab's identical prop. */
  onCountChange?: (count: number) => void;
} = {}) {
  const {
    data: fetchedRead,
    loading,
    error,
    reload,
  } = useAsync(() => listPastJiraTickets(), []);

  const [tickets, setTickets] = useState<JiraTicket[]>([]);
  useEffect(() => {
    if (fetchedRead) setTickets(fetchedRead.tickets);
  }, [fetchedRead]);
  useEffect(() => {
    onCountChange?.(tickets.length);
    // onCountChange intentionally omitted — see RoleTicketsTab's identical
    // effect for why.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets]);

  function updateTicket(updated: JiraTicket) {
    setTickets((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  const paged = usePagedTickets(tickets);

  const [drawerTicketId, setDrawerTicketId] = useState<string | null>(null);
  const drawerTicket = drawerTicketId
    ? (tickets.find((t) => t.id === drawerTicketId) ?? null)
    : null;

  // See RoleTicketsTab's own header for why these throw instead of
  // silently no-op: neither read this tab performs ever produces a
  // hasConflict/isTombstoned ticket, so JiraTicketRow should never call
  // either.
  async function neverResolvesConflict(): Promise<void> {
    throw new Error('PastTicketsTab: hasConflict is always false here');
  }
  async function neverDismissesTombstone(): Promise<void> {
    throw new Error('PastTicketsTab: isTombstoned is always false here');
  }

  return (
    <div>
      <p className="mb-3 max-w-[70ch] text-[12px] text-text-muted">
        Tickets that used to be assigned to you and aren&apos;t anymore —
        reassigned away, not resolved.
      </p>
      <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface shadow-sm">
        {loading && tickets.length === 0 ? (
          <SkeletonListRows />
        ) : (
          <>
            {error && (
              <JiraLoadError
                what="your past tickets"
                error={error}
                onRetry={reload}
              />
            )}
            {!error && tickets.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-text-muted">
                Nothing was ever reassigned away from you.
              </div>
            )}
            {!error &&
              paged.pageItems.map((ticket) => (
                <JiraTicketRow
                  key={ticket.id}
                  ticket={ticket}
                  onOpenDrawer={setDrawerTicketId}
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
          onClose={() => setDrawerTicketId(null)}
        />
      )}
    </div>
  );
}
