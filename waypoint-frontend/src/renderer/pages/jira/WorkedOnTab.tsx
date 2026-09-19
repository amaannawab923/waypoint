import { useEffect, useState } from 'react';
import { listWorkedOnJiraKeys } from '@/data/api';
import { listTicketsByJiraKeys } from '@/data/jiraApi';
import { useAsync } from '@/lib/useAsync';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { JiraTicketRow } from '@/components/domain/JiraTicketRow';
import { JiraTicketDrawer } from '@/components/domain/JiraTicketDrawer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import { JiraApiError } from '@/types/jira';
import type { JiraTicket } from '@/types/jira';
import { usePagedTickets } from './usePagedTickets';
import JiraTicketPager from './JiraTicketPager';

/**
 * The Worked-on tab: every Jira issue this member has an agent run against,
 * on the connected site — two reads chained (the backend's own history via
 * data/api.ts's listWorkedOnJiraKeys, then those keys resolved to real
 * ticket rows via jiraApi.ts's listTicketsByJiraKeys), not one. A key the
 * backend still remembers but Jira no longer returns (deleted, moved to a
 * project this account can no longer see) is silently absent from the
 * result — listTicketsByJiraKeys' own comment covers why that is a normal
 * outcome here, not an error.
 *
 * Self-contained like RoleTicketsTab, and for the same reason: one of
 * several sibling tab components a thin page shell mounts one at a time.
 * No search box — unlike the per-role tabs, nothing in the redesign asked
 * for one here.
 */
export default function WorkedOnTab({
  onCountChange,
}: {
  /** Reports the live tickets count up to the page's own tab label — see
   * MyJiraPage.tsx's TAB_COUNTS state and RoleTicketsTab's identical prop. */
  onCountChange?: (count: number) => void;
} = {}) {
  const connection = useLoadedJiraConnection();

  const {
    data: fetchedTickets,
    loading,
    error,
    reload,
  } = useAsync(async () => {
    // Not yet known whether an account is connected — neither a real
    // result nor a real failure, so this resolves through as "nothing
    // yet" rather than throwing; the effect re-runs once
    // useLoadedJiraConnection settles the real status below.
    if (!connection) return [];
    if (!connection.connected) {
      throw new JiraApiError('No Jira account is connected.', 'not_connected');
    }
    const keys = await listWorkedOnJiraKeys(connection.site);
    return listTicketsByJiraKeys(keys);
  }, [connection === undefined, connection?.connected, connection?.site]);

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
    throw new Error('WorkedOnTab: hasConflict is always false here');
  }
  async function neverDismissesTombstone(): Promise<void> {
    throw new Error('WorkedOnTab: isTombstoned is always false here');
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
                what="what you've worked on"
                error={error}
                onRetry={reload}
              />
            )}
            {!error && tickets.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-text-muted">
                No agent runs against a Jira issue yet.
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
