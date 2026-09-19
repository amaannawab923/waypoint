import { useEffect, useState } from 'react';
import { listTicketsByJiraKeys } from '@/data/jiraApi';
import { useAsync } from '@/lib/useAsync';
import { useJiraStarredKeys } from '@/lib/jiraStarred';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { JiraTicketRow } from '@/components/domain/JiraTicketRow';
import { JiraTicketDrawer } from '@/components/domain/JiraTicketDrawer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraTicket } from '@/types/jira';

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
    throw new Error('StarredTab: hasConflict is always false here');
  }
  async function neverDismissesTombstone(): Promise<void> {
    throw new Error('StarredTab: isTombstoned is always false here');
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
