import { useEffect, useState } from 'react';
import { listRoleJiraTickets } from '@/data/jiraApi';
import { useAsync } from '@/lib/useAsync';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { JiraTicketRow } from '@/components/domain/JiraTicketRow';
import { JiraTicketDrawer } from '@/components/domain/JiraTicketDrawer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraTicket, JiraTicketQueryRole } from '@/types/jira';
import { usePagedTickets } from './usePagedTickets';
import JiraTicketPager from './JiraTicketPager';

// Long enough that a normal typing rate sends one search per word rather
// than one per keystroke, short enough that results have caught up by the
// time someone stops to read them — same value and reasoning as
// JiraAssigneePicker's own debounce, the other place this app debounces a
// query into a live Jira search.
const SEARCH_DEBOUNCE_MS = 250;

const TAB_COPY: Record<
  JiraTicketQueryRole,
  { empty: string; placeholder: string }
> = {
  assignee: {
    empty: "Nothing assigned to you that's still unresolved.",
    placeholder: 'Search what’s assigned to you…',
  },
  reporter: {
    empty: "Nothing you've reported that's still unresolved.",
    placeholder: 'Search what you’ve reported…',
  },
  watcher: {
    empty: "You're not watching anything unresolved right now.",
    placeholder: 'Search what you’re watching…',
  },
};

/**
 * One Assigned/Reported/Watching tab: a server-scoped read of exactly that
 * role's own queue (see jiraClient.ts's listRoleTickets), with its own
 * debounced search box that re-queries Jira rather than filtering an
 * already-loaded list — unlike the old My work tab's useMyJiraQueue, there
 * is no client-side filter here because there is nothing client-side to
 * filter: `search` only ever exists as a JQL clause main builds through
 * jqlQuoted.
 *
 * Self-contained on purpose, owning its own ticket state and its own ticket
 * drawer, rather than lifting them to MyJiraPage — this is meant to be one
 * of several sibling tab components (this one repeated three ways, plus
 * Viewed/My past tickets/All Tickets alongside it) that a thin page shell
 * mounts one at a time, not a fragment that reaches back into a shared page
 * state object.
 *
 * `onResolveConflict`/`onDismissTombstone` are still real props JiraTicketRow
 * requires, but neither can ever fire here: every ticket this tab reads comes
 * back with `hasConflict: false` and `isTombstoned: false` unconditionally
 * (see listRoleJiraTickets's own comment — a per-role read is never compared
 * against a previous one). The no-ops below are the honest reflection of
 * that, not a placeholder for work still to do.
 */
export default function RoleTicketsTab({
  queryRole,
  onCountChange,
}: {
  // Not named `role`: eslint's jsx-a11y/aria-role reads any JSX prop literally
  // named `role` as an ARIA role attribute, which produces a false positive
  // on a plain custom-component prop — sidestepped by naming it for what it
  // actually is, matching JiraTicketQueryRole's own name.
  queryRole: JiraTicketQueryRole;
  /** Reports the live tickets count up to the page's own tab label — see
   * MyJiraPage.tsx's TAB_COUNTS state. Fires with the search-filtered count,
   * same as what the list itself shows, not a separate unfiltered total. */
  onCountChange?: (count: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedQuery(query),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query]);

  const {
    data: fetchedRead,
    loading,
    error,
    reload,
  } = useAsync(
    () => listRoleJiraTickets(queryRole, debouncedQuery),
    [queryRole, debouncedQuery],
  );
  const [tickets, setTickets] = useState<JiraTicket[]>([]);
  useEffect(() => {
    if (fetchedRead) setTickets(fetchedRead.tickets);
  }, [fetchedRead]);
  // Found in manual testing: switching Assigned -> Reported -> Watching
  // re-renders this SAME component instance with a new queryRole (all three
  // tabs mount it at the same position in MyJiraPage's tree, so React
  // reuses it rather than remounting) — without this, the previous role's
  // tickets stayed on screen, untouched, for the entire round trip of the
  // new fetch, with no loading state ever showing (the skeleton only
  // appears when `tickets` is empty). Someone switching to Watching saw
  // Reported's own rows and had no way to tell they were stale. Clearing
  // immediately on a role change — not waiting for the new data — is what
  // makes `loading && tickets.length === 0` below correctly show the
  // skeleton for every role switch, not just the first mount.
  useEffect(() => {
    setTickets([]);
  }, [queryRole]);
  useEffect(() => {
    // Not reported while a fetch is in flight — the interim `tickets: []`
    // the effect above clears to would otherwise flash the tab's own count
    // badge to 0 and back on every role switch, which is exactly the kind
    // of "is this real or stale" confusion this whole fix exists to remove.
    if (!loading) onCountChange?.(tickets.length);
    // onCountChange intentionally omitted: MyJiraPage passes a plain inline
    // callback (not memoized), and depending on it here would re-fire this
    // effect on every page render rather than only when the count itself
    // changes — see useAsync.ts's own `run` callback for the same pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, loading]);

  const paged = usePagedTickets(tickets);

  const [drawerTicketId, setDrawerTicketId] = useState<string | null>(null);
  const drawerTicket = drawerTicketId
    ? (tickets.find((t) => t.id === drawerTicketId) ?? null)
    : null;

  function updateTicket(updated: JiraTicket) {
    setTickets((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  // See this component's own header: neither of these can ever fire from a
  // per-role read (hasConflict/isTombstoned are always false), so they throw
  // rather than silently no-op — if one ever does fire, an assumption this
  // component depends on stopped holding somewhere upstream.
  async function neverResolvesConflict(): Promise<void> {
    throw new Error(
      'RoleTicketsTab: hasConflict is always false on a per-role read',
    );
  }
  async function neverDismissesTombstone(): Promise<void> {
    throw new Error(
      'RoleTicketsTab: isTombstoned is always false on a per-role read',
    );
  }

  const copy = TAB_COPY[queryRole];

  return (
    <div>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={copy.placeholder}
        aria-label={copy.placeholder}
        className="block w-full max-w-[360px] rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
      />

      {fetchedRead?.truncated && (
        <div className="mt-2 rounded-[var(--radius-sm)] border border-warning/30 bg-warning-bg px-3 py-2 text-[11.5px] leading-relaxed text-warning">
          {fetchedRead.truncated === 'page-cap'
            ? 'Jira had more issues than this app reads in one go — this is the first 500, most recently updated.'
            : 'Jira reported more issues than it would hand over, so this list may be incomplete. Try refreshing.'}
        </div>
      )}

      <div className="mt-3 overflow-hidden rounded-[var(--radius)] border border-border bg-surface shadow-sm">
        {loading && tickets.length === 0 ? (
          <SkeletonListRows />
        ) : (
          <>
            {error && (
              <JiraLoadError what="this queue" error={error} onRetry={reload} />
            )}
            {!error && tickets.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-text-muted">
                {debouncedQuery ? 'No tickets match your search.' : copy.empty}
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
