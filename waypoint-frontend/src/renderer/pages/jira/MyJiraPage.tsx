import { useEffect, useState } from 'react';
import { humanizeAgo } from '@/lib/duration';
import { TAB_COUNTS_EXPLAINER } from '@/lib/jiraCopy';
import { useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  dismissJiraTombstone,
  ensureJiraSynced,
  getJiraConnectionStatus,
  listMyJiraTickets,
  resolveJiraConflict,
} from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { useAsync } from '@/lib/useAsync';
import { setJiraConnection, useLoadedJiraConnection } from '@/lib/jiraStore';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { JiraMark } from '@/components/domain/JiraMark';
import { JiraTicketRow } from '@/components/domain/JiraTicketRow';
import { JiraTicketDrawer } from '@/components/domain/JiraTicketDrawer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import { JiraConnectionPanel } from '@/components/domain/JiraConnectionPanel';
import type {
  JiraTicket,
  JiraTicketQueryRole,
  JiraTruncation,
} from '@/types/jira';
import MyJiraToolbar from './MyJiraToolbar';
import MyJiraPager from './MyJiraPager';
import { useMyJiraQueue } from './useMyJiraQueue';
import RoleTicketsTab from './RoleTicketsTab';
import WorkedOnTab from './WorkedOnTab';
import ViewedTab from './ViewedTab';
import StarredTab from './StarredTab';
import PastTicketsTab from './PastTicketsTab';

// ROAD-158 redesign: the old single 'work' tab (the assignee/reporter/
// watcher union query) is now 'all' — "All Tickets", the old screen kept
// intact under a name that matches what it actually shows once Assigned/
// Reported/Watching exist as their own, narrower tabs. Assigned is now the
// default landing tab, per the founder's own call on the mockup. Order and
// full tab set match the approved mockup exactly.
type TabKey =
  | 'assigned'
  | 'reported'
  | 'watching'
  | 'worked-on'
  | 'viewed'
  | 'starred'
  | 'past'
  | 'all'
  | 'connection';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'assigned', label: 'Assigned' },
  { key: 'reported', label: 'Reported' },
  { key: 'watching', label: 'Watching' },
  { key: 'worked-on', label: 'Worked on' },
  { key: 'viewed', label: 'Viewed' },
  { key: 'starred', label: 'Starred' },
  { key: 'past', label: 'My past tickets' },
  { key: 'all', label: 'All Tickets' },
  { key: 'connection', label: 'Connection' },
];

// Tabs whose own count this page tracks and shows next to their label — the
// self-contained tab components report it live via onCountChange as their
// own read settles. 'all' and 'connection' are deliberately absent: 'all'
// already shows its own "N issues · M projects" line inside its body (adding
// a second count next to the tab would just be the same fact said twice),
// and 'connection' has no ticket count to show at all.
type CountedTabKey =
  | 'assigned'
  | 'reported'
  | 'watching'
  | 'worked-on'
  | 'viewed'
  | 'starred'
  | 'past';

// The three per-role tabs' own TabKey -> the query role RoleTicketsTab
// actually takes. A lookup rather than a nested ternary at the call site.
const ROLE_TAB_QUERY_ROLE: Record<
  'assigned' | 'reported' | 'watching',
  JiraTicketQueryRole
> = {
  assigned: 'assignee',
  reported: 'reporter',
  watching: 'watcher',
};

/** True only for a real `TabKey` — used to validate the `?tab=` param below
 * against the actual union rather than trusting a string a link (this app's
 * own `JiraConnectionCard`, or anything else) put in the URL. Built off
 * `TABS` itself so a third tab added there is a third valid value here with
 * no second list to keep in sync. */
function isTabKey(value: string | null): value is TabKey {
  return TABS.some((t) => t.key === value);
}

/**
 * Exported (not just page-local) because `JiraConnectionCard` on the
 * All-Projects page needs the identical "synced Ns ago" / "not synced yet"
 * reading rather than a second implementation that could drift from this
 * one — see that component's own header for why.
 */
export function LiveSyncIndicator({
  lastSyncAt,
}: {
  lastSyncAt: string | null;
}) {
  // Re-renders once a second purely so the "synced Ns ago" label keeps
  // advancing. `lastSyncAt` is genuinely the moment the JQL search last ran
  // against the connected site, so this age is real — but nothing refreshes
  // it on a timer, which is exactly why the label reports an age rather than
  // implying a live stream.
  //
  // `null` means no search has come back yet this session — offline at
  // launch, a dead token, or simply the second before the first read lands.
  // That case gets its own muted, un-pulsing label rather than the green
  // "synced 0s ago" it used to borrow from a module-load timestamp.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!lastSyncAt) {
    return (
      <span className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] font-bold text-text-muted">
        <span className="size-1.5 shrink-0 rounded-full bg-text-muted" />
        not loaded yet
      </span>
    );
  }
  // "loaded", not "synced" (feedback round 1, Fix 6/9): Waypoint reads
  // Jira on demand and holds a copy; nothing is kept in sync in the
  // background, and the word should not promise that it is.
  return (
    <span
      className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] font-bold text-success"
      title="When Waypoint last read your tickets from Jira. Reload to read again."
    >
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" />
      loaded {humanizeAgo(lastSyncAt)}
    </span>
  );
}

export default function MyJiraPage() {
  // `JiraConnectionCard` on the All-Projects page links straight to the
  // Connection tab (`/my-jira?tab=connection`) rather than always landing on
  // Assigned — read once at mount, the same way TicketsLayout/AllTicketsPage
  // seed state from their own query params. An absent or garbage value
  // (someone hand-editing the URL, or a future link that gets the param
  // wrong) falls back to 'assigned' via `isTabKey` rather than rendering
  // neither tab's body.
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<TabKey>(
    isTabKey(initialTab) ? initialTab : 'assigned',
  );
  const [drawerTicketId, setDrawerTicketId] = useState<string | null>(null);

  // Live per-tab ticket counts, shown next to each tab's own label — see
  // CountedTabKey's own comment for which tabs report one and why. A
  // functional update that bails out when the incoming count already
  // matches keeps a tab's own re-render (its useAsync settling again on an
  // unrelated re-mount) from cascading into a fresh page-level render when
  // nothing actually changed.
  const [counts, setCounts] = useState<Partial<Record<CountedTabKey, number>>>(
    {},
  );
  function countHandler(key: CountedTabKey) {
    return (count: number) =>
      setCounts((prev) =>
        prev[key] === count ? prev : { ...prev, [key]: count },
      );
  }

  const connection = useLoadedJiraConnection();

  // Found in review: this page used to call listMyJiraTickets() — a real,
  // full 5-page crawl — unconditionally on every mount, even though the
  // default landing tab is now Assigned, which has nothing to do with its
  // result. The header's sync indicator (just below, rendered regardless of
  // which tab is open) still needs SOME real numbers, though — ensureJiraSynced
  // is the primitive that exists precisely for "guarantee at least one real
  // read has happened this session" without repeating it on every later
  // visit: a no-op the moment lastSyncAt is already set, from this page or
  // anywhere else (the All Projects tile, the sidebar).
  useEffect(() => {
    // Never rejects (see ensureJiraSynced's own comment — a failed
    // background sync resolves with the pre-read status rather than
    // throwing), but a bare .then() with nothing to answer to still reads
    // as an unhandled rejection risk to the linter.
    ensureJiraSynced()
      .then(setJiraConnection)
      .catch(() => {});
  }, []);

  // The full "my work" ticket list itself is only actually consumed by the
  // All Tickets tab's own body below — the other eight tabs each run their
  // own scoped read — and by the Connection tab's Refresh button, wired to
  // reloadTickets. Gated on tab rather than fetched unconditionally, for
  // the same reason as the effect above: visiting Assigned, Reported, or
  // any other tab has no use for a list it never renders.
  const {
    data: fetchedRead,
    loading,
    // A failed list read used to be dropped on the floor here, so a 401, a
    // 429, a timeout and an offline laptop all rendered as "No tickets match
    // these filters." next to a green sync dot. The error is now carried to
    // the list body below.
    error: ticketsError,
    reload: reloadTickets,
  } = useAsync(
    () =>
      tab === 'all' || tab === 'connection'
        ? listMyJiraTickets()
        : Promise.resolve(null),
    [tab === 'all' || tab === 'connection'],
  );
  const [tickets, setTickets] = useState<JiraTicket[]>([]);
  // Held separately from `tickets` rather than read off `fetchedRead` at
  // render, because `tickets` is patched in place by every write on this page
  // (a transition, a reassign, a dismissed tombstone) while the cap is a
  // property of the read that produced them and does not change when a row
  // does. Both are set from the same effect so they can never describe two
  // different reads.
  const [truncated, setTruncated] = useState<JiraTruncation>(false);
  useEffect(() => {
    if (!fetchedRead) return;
    setTickets(fetchedRead.tickets);
    setTruncated(fetchedRead.truncated);
    // Found in review: this list read and useLoadedJiraConnection's own
    // status read both fire on mount, but the status read is a fast,
    // purely-local file check (jiraApi.ts's own comment on
    // getJiraConnectionStatus) while this one is a real network round trip
    // to Jira — so the status read routinely wins the race and caches a
    // connection object with issueCount/projectCount/lastSyncAt still at
    // their zero/null defaults into the shared jiraStore, which nothing
    // afterward ever refreshes. The visible bug: reconnect, restart, or
    // land straight on the Connection tab, and it shows "Connected" next
    // to "0 issues" / "not synced yet" even though this exact read (right
    // here) has real numbers a moment later. getJiraConnectionStatus() is
    // cheap to call again now — it only re-reads the in-memory counts this
    // read just populated, no second network call — so re-push the shared
    // store with the now-correct snapshot every time a read lands, not
    // just on the very first mount.
    getJiraConnectionStatus().then(setJiraConnection);
  }, [fetchedRead]);

  function updateTicket(updated: JiraTicket) {
    setTickets((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function handleResolveConflict(ticketId: string) {
    try {
      const updated = await resolveJiraConflict(ticketId);
      updateTicket(updated);
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not re-read this ticket from Jira.',
      );
    }
  }

  async function handleDismissTombstone(ticketId: string) {
    try {
      await dismissJiraTombstone(ticketId);
      setTickets((ts) => ts.filter((t) => t.id !== ticketId));
      if (drawerTicketId === ticketId) setDrawerTicketId(null);
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Could not clear this ticket.',
      );
    }
  }

  // Every filter, the sort and the pagination, all client-side over the array
  // already read — see useMyJiraQueue's own header for the four reasons that
  // is deliberate rather than lazy, and for what it costs.
  const queue = useMyJiraQueue(tickets);
  const { matched, pageItems } = queue;

  const visibleProjectCount = new Set(matched.map((t) => t.projectKey)).size;
  const drawerTicket = drawerTicketId
    ? (tickets.find((t) => t.id === drawerTicketId) ?? null)
    : null;

  return (
    <div className="mx-auto max-w-6xl p-6 md:p-8">
      <div className="flex items-center gap-2.5">
        <div className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-jira-bg text-jira">
          <JiraMark size={16} />
        </div>
        <h1 className="font-display text-[19px] font-semibold text-text">
          My Jira
        </h1>
        {connection && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-2.5 py-1 text-[11.5px] text-text-secondary">
            {connection.accountName} · {connection.site}
          </span>
        )}
        {connection && <LiveSyncIndicator lastSyncAt={connection.lastSyncAt} />}
      </div>

      {/* Only All Tickets keeps this sentence: it is the one tab whose own
          query is a union across roles, and the one place "every project you
          can see, not one board" is still the whole story. The per-role tabs
          say what they show in their own tab label; describing them again
          here would be the same on-screen JQL restatement Phase 1 removed,
          just moved up a level. */}
      {tab === 'all' && (
        <p className="mt-1.5 ml-[41px] max-w-[70ch] text-[12.5px] text-text-secondary">
          Everything assigned to you, reported by you, or watched by you —
          across <b>every</b> Jira project you can see, not one board.
        </p>
      )}

      {/* role="tablist"/"tab": real ARIA tab semantics, not generic buttons
          — both because this genuinely is a tab strip and because "Assigned"
          /"Reported"/"Watching" are now real words on this page twice, once
          here and once as the All Tickets tab's own role-filter chip labels
          (MyJiraToolbar.tsx's ROLE_FILTERS). Identical visible text at two
          different roles ("tab" vs the chip's plain "button") is what keeps
          them unambiguous to a query by name, the same way a sighted person
          tells them apart by where they sit on screen. */}
      <div
        role="tablist"
        aria-label="My Jira sections"
        className="mt-3.5 ml-[41px] flex gap-1 overflow-x-auto border-b border-border"
      >
        {TABS.map((t) => {
          const count = counts[t.key as CountedTabKey];
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={clsx(
                'flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors',
                tab === t.key
                  ? 'border-accent text-text'
                  : 'border-transparent text-text-muted hover:text-text-secondary',
              )}
            >
              {t.label}
              {count !== undefined && (
                <span
                  title={TAB_COUNTS_EXPLAINER}
                  className={clsx(
                    'rounded-full px-1.5 py-0.5 font-mono text-[10.5px] font-medium',
                    tab === t.key
                      ? 'bg-jira-bg text-jira'
                      : 'bg-surface-2 text-text-muted',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {(tab === 'assigned' || tab === 'reported' || tab === 'watching') && (
        <div className="mt-4 ml-[41px]">
          <RoleTicketsTab
            queryRole={ROLE_TAB_QUERY_ROLE[tab]}
            onCountChange={countHandler(tab)}
          />
        </div>
      )}

      {tab === 'worked-on' && (
        <div className="mt-4 ml-[41px]">
          <WorkedOnTab onCountChange={countHandler('worked-on')} />
        </div>
      )}

      {tab === 'viewed' && (
        <div className="mt-4 ml-[41px]">
          <ViewedTab onCountChange={countHandler('viewed')} />
        </div>
      )}

      {tab === 'starred' && (
        <div className="mt-4 ml-[41px]">
          <StarredTab onCountChange={countHandler('starred')} />
        </div>
      )}

      {tab === 'past' && (
        <div className="mt-4 ml-[41px]">
          <PastTicketsTab onCountChange={countHandler('past')} />
        </div>
      )}

      {tab === 'all' && (
        <div className="mt-4 ml-[41px]">
          {loading && !fetchedRead ? (
            <SkeletonListRows />
          ) : (
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1 basis-[460px]">
                {/* Deliberately outside the overflow-hidden list container
                    below: both of its popovers open as `absolute z-40` panels
                    and would be clipped at that container's edge. */}
                <MyJiraToolbar queue={queue} totalCount={tickets.length} />

                <div className="mb-1.5 flex items-center justify-between gap-2.5 text-[11.5px] text-text-muted">
                  {/* Counts the whole matched set, not the current page —
                      "4 issues" is a fact about the queue you filtered to,
                      and paging through it must not appear to shrink it. The
                      page's own range lives in the pager's footer instead. */}
                  <span>
                    {matched.length} issue{matched.length === 1 ? '' : 's'} ·{' '}
                    {visibleProjectCount} Jira project
                    {visibleProjectCount === 1 ? '' : 's'}
                  </span>
                  {/* This used to read "polls every 15s". Nothing polls —
                      the list is read on mount and on the Connection tab's
                      Refresh — so it now says what actually happens.
                      It briefly read "one API call" next, which is only
                      true when the queue fits on the first page — see
                      jiraClient.ts's listMyTickets: PAGE_SIZE is 100 and
                      MAX_PAGES is 5, so a queue over 100 issues pages the
                      same JQL search across more than one request, and
                      there is no fixed count honest to print here. It then
                      briefly read "re-reads the whole queue", which is false
                      for exactly the users the truncation strip below is
                      for: listMyTickets stops at MAX_PAGES × PAGE_SIZE, so
                      on a queue past 500 a refresh re-reads the first 500,
                      and the strip says so 25 lines down. What is stable,
                      and what this sentence actually means, is that the
                      search only runs when this page opens or Refresh is
                      pressed — nothing polls in between (the Connection
                      tab's own "Not built yet" list states the same
                      contract). "Re-runs the search" is true in every
                      state, truncated or not. */}
                  {connection && <span>refresh re-runs the search</span>}
                </div>

                {/* A standing fact about the list below, not an event — so a
                    strip that sits there for as long as it is true, and
                    deliberately NOT a toast (which would announce itself once
                    and then be gone while the thing it warned about stayed on
                    screen) and NOT role="alert" (JiraLoadError owns that
                    register here; a read that succeeded but came back short is
                    not the same news as a read that failed).

                    `warning`, not `danger`: nothing is broken and nothing
                    needs fixing. The list is real, it is just a prefix.

                    What it claims is exactly what listMyTickets guarantees —
                    the first PAGE_SIZE × MAX_PAGES of MY_WORK_JQL's own
                    `ORDER BY updated DESC` — and nothing more. It offers no
                    "load the rest" action because there is none: raising the
                    cap is the deliberate non-decision documented on those
                    constants, and a button that cannot do what it says is
                    worse than no button. The 500 is written out rather than
                    imported because those constants live in the main process
                    and are not part of the wire contract; if they ever move,
                    this sentence moves with them. */}
                {truncated && (
                  <div className="mb-1.5 rounded-[var(--radius-sm)] border border-warning/30 bg-warning-bg px-3 py-2 text-[11.5px] leading-relaxed text-warning">
                    {truncated === 'page-cap'
                      ? 'Jira had more issues than this app reads in one go — this is the first 500, most recently updated. The filters and sorting below apply only to these.'
                      : /* Says nothing about how many were read, because this
                           case says nothing about it: Jira reported more work
                           and returned no way to ask for it, which can happen
                           on the very first page. Naming a 500-issue cap here
                           would invent a cause. */
                        'Jira reported more issues than it would hand over, so this list may be incomplete. Refresh to try again. The filters and sorting below apply only to what loaded.'}
                  </div>
                )}

                {/* Four distinct outcomes, deliberately not collapsed: the
                    read failed; it succeeded over a genuinely empty queue; it
                    succeeded over a real queue that the current filters
                    narrowed to nothing; or there are rows. The middle two used
                    to share one sentence, and "No tickets match these
                    filters." over an unfiltered empty queue reads as a
                    malfunction rather than as good news.

                    The error is rendered even when rows are present (a reload
                    can fail over a list this page already has) so nothing on
                    screen silently predates a failure.

                    The empty-queue branch is also reachable, slightly wrongly,
                    after handleDismissTombstone empties the list — the queue
                    was not empty, we emptied it. That path cannot happen today
                    (toTicket never marks anything tombstoned) and special-
                    casing an unreachable state would be inventing a case to
                    handle it. */}
                <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface shadow-sm">
                  {ticketsError && (
                    <JiraLoadError
                      what="your Jira queue"
                      error={ticketsError}
                      onRetry={reloadTickets}
                    />
                  )}
                  {!ticketsError && tickets.length === 0 && (
                    <div className="px-4 py-6 text-center text-sm text-text-muted">
                      <p className="font-semibold text-text-secondary">
                        Nothing in your Jira queue.
                      </p>
                      <p className="mt-1">
                        Nothing is assigned to, reported by, or watched by you
                        that&apos;s still unresolved.
                      </p>
                    </div>
                  )}
                  {!ticketsError &&
                    tickets.length > 0 &&
                    matched.length === 0 && (
                      <div className="px-4 py-6 text-center text-sm text-text-muted">
                        No tickets match these filters.
                        <button
                          type="button"
                          onClick={queue.resetQuery}
                          className="mt-2 block w-full cursor-pointer text-sm font-medium text-accent hover:underline"
                        >
                          Clear filters
                        </button>
                      </div>
                    )}
                  {pageItems.map((ticket) => (
                    <JiraTicketRow
                      key={ticket.id}
                      ticket={ticket}
                      onOpenDrawer={setDrawerTicketId}
                      onTicketUpdated={updateTicket}
                      onResolveConflict={handleResolveConflict}
                      onDismissTombstone={handleDismissTombstone}
                    />
                  ))}
                </div>

                <MyJiraPager queue={queue} />

                {/* "see the rail" used to end this sentence, pointing at a
                    Copilot proposal card that never had a producer and has
                    been removed. Copilot's own Jira writes are still approved
                    explicitly — they just surface as proposal cards in the
                    Copilot panel, not beside this list.

                    This used to also claim "~400ms" for a click's own write.
                    Nothing in this app measures that number — it was invented,
                    the same defect commit e9e1ec9 exists to catch — and the one
                    real measurement on record (this ticket's own) is 1752ms for
                    a full My Jira LOAD, not a write, which the line was not even
                    describing. Removed rather than replaced with a different
                    unmeasured guess. The two claims that remain are both true
                    and checkable: no approval step (this click writes directly,
                    with nothing in between — see the writes this panel's own
                    Connection tab enumerates), and Copilot's own writes are
                    never direct — see CopilotProposalCard.tsx's
                    ExternalWriteBanner, which is shown before every external
                    write and is not optional, and proposalApproval.ts, where
                    the Jira credential is attached to exactly two channels —
                    'copilot:proposals:approve' and
                    'copilot:proposals:bulk-approve' — both of them an
                    explicit click, and to nothing else. */}
                <div className="mt-3 flex items-start gap-2 rounded-[var(--radius-sm)] border border-jira/30 bg-jira-bg px-3 py-2.5 text-[12.5px] text-jira">
                  <span>
                    Your own clicks write straight to Jira — no approval step.
                    Copilot&apos;s never do.
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'connection' && (
        <div className="mt-4 ml-[41px]">
          {connection ? (
            <JiraConnectionPanel
              connection={connection}
              onRefresh={reloadTickets}
            />
          ) : (
            <SkeletonListRows />
          )}
        </div>
      )}

      {drawerTicket && (
        <JiraTicketDrawer
          ticket={drawerTicket}
          // The same patch-in-place the rows already use, so a reassign made
          // in the drawer lands on the row behind it too — and, per the same
          // rule, never removes it: a ticket reassigned away from the user
          // stays in the list until the next refresh re-runs the query.
          onTicketUpdated={updateTicket}
          onClose={() => setDrawerTicketId(null)}
        />
      )}
    </div>
  );
}
