import { useEffect, useState } from 'react';
import { listViewedJiraTickets } from '@/data/jiraApi';
import { useAsync } from '@/lib/useAsync';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { JiraTicketRow } from '@/components/domain/JiraTicketRow';
import { JiraTicketDrawer } from '@/components/domain/JiraTicketDrawer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraTicket } from '@/types/jira';

/**
 * The Viewed tab: Jira's own view history for this account (see
 * jiraClient.ts's VIEWED_JQL and its own live-verification note), newest
 * first. Self-contained like RoleTicketsTab/WorkedOnTab, and for the same
 * reason. No search box — nothing in the redesign asked for one here either.
 */
export default function ViewedTab({
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
  } = useAsync(() => listViewedJiraTickets(), []);

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

  const [drawerTicketId, setDrawerTicketId] = useState<string | null>(null);
  const drawerTicket = drawerTicketId
    ? (tickets.find((t) => t.id === drawerTicketId) ?? null)
    : null;

  // See RoleTicketsTab's own header for why these throw instead of
  // silently no-op: neither read this tab performs ever produces a
  // hasConflict/isTombstoned ticket, so JiraTicketRow should never call
  // either.
  async function neverResolvesConflict(): Promise<void> {
    throw new Error('ViewedTab: hasConflict is always false here');
  }
  async function neverDismissesTombstone(): Promise<void> {
    throw new Error('ViewedTab: isTombstoned is always false here');
  }

  return (
    <div>
      <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface shadow-sm">
        {loading && tickets.length === 0 ? (
          <SkeletonListRows />
        ) : (
          <>
            {error && (
              <JiraLoadError
                what="what you've viewed"
                error={error}
                onRetry={reload}
              />
            )}
            {!error && tickets.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-text-muted">
                Nothing in your Jira view history yet.
              </div>
            )}
            {!error &&
              tickets.map((ticket) => (
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
