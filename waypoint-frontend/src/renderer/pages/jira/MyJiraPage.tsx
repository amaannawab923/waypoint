import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import {
  dismissJiraDuplicateNudge,
  dismissJiraTombstone,
  getJiraDuplicateNudge,
  getMyJiraProposal,
  listMyJiraTickets,
  resolveJiraConflict,
} from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { useAsync } from '@/lib/useAsync';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { JiraMark } from '@/components/domain/JiraMark';
import { JiraTicketRow } from '@/components/domain/JiraTicketRow';
import { JiraTicketDrawer } from '@/components/domain/JiraTicketDrawer';
import { JiraProposalCard } from '@/components/domain/JiraProposalCard';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import { JiraConnectionPanel } from '@/components/domain/JiraConnectionPanel';
import type {
  JiraDuplicateNudge,
  JiraProposal,
  JiraTicket,
  JiraTruncation,
} from '@/types/jira';
import MyJiraToolbar from './MyJiraToolbar';
import MyJiraPager from './MyJiraPager';
import { useMyJiraQueue } from './useMyJiraQueue';

type TabKey = 'work' | 'connection';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'work', label: 'My work' },
  { key: 'connection', label: 'Connection' },
];

function LiveSyncIndicator({ lastSyncAt }: { lastSyncAt: string | null }) {
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
        not synced yet
      </span>
    );
  }
  const secs = Math.max(
    0,
    Math.round((Date.now() - new Date(lastSyncAt).getTime()) / 1000),
  );
  const label = secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] font-bold text-success">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" />
      synced {label}
    </span>
  );
}

/**
 * The "My work" tab's Copilot rail — the proposal card plus the small
 * "Also queued" duplicate nudge underneath it (mockup's `.work-rail`).
 * Renders nothing when neither exists, so an empty rail never reserves
 * layout space next to the ticket list.
 */
function CopilotRail({
  proposal,
  onProposalResolved,
  nudge,
  onOpenDrawer,
  onNudgeDismissed,
}: {
  proposal: JiraProposal | null;
  onProposalResolved: (updated: JiraProposal) => void;
  nudge: JiraDuplicateNudge | null;
  onOpenDrawer: (ticketId: string) => void;
  onNudgeDismissed: () => void;
}) {
  const [dismissing, setDismissing] = useState(false);

  async function handleDismiss() {
    if (!nudge) return;
    setDismissing(true);
    try {
      await dismissJiraDuplicateNudge(nudge.id);
      onNudgeDismissed();
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Could not dismiss this.',
      );
    } finally {
      setDismissing(false);
    }
  }

  if (!proposal && !nudge) return null;

  return (
    <div className="flex w-full flex-col gap-3 sm:w-[292px] sm:min-w-[262px] sm:shrink-0">
      {proposal && (
        <JiraProposalCard proposal={proposal} onResolved={onProposalResolved} />
      )}
      {nudge && (
        <div className="rounded-[var(--radius-sm)] border border-border bg-surface p-2.5 text-xs leading-relaxed text-text-secondary shadow-sm">
          <b className="text-text">Also queued</b> — Copilot thinks{' '}
          <span
            className="font-mono font-semibold"
            style={{ color: nudge.ticketProjectColor }}
          >
            {nudge.ticketKey}
          </span>{' '}
          duplicates{' '}
          <span
            className="font-mono font-semibold"
            style={{ color: nudge.ticketProjectColor }}
          >
            {nudge.duplicateOfKey}
          </span>{' '}
          (same Safari 17.4 stack trace).
          <div className="mt-2 flex gap-1.5">
            <Button size="xs" onClick={() => onOpenDrawer(nudge.ticketId)}>
              Review
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={dismissing}
              onClick={handleDismiss}
            >
              {dismissing ? 'Dismissing…' : 'Dismiss'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MyJiraPage() {
  const [tab, setTab] = useState<TabKey>('work');
  const [drawerTicketId, setDrawerTicketId] = useState<string | null>(null);

  const connection = useLoadedJiraConnection();
  const {
    data: fetchedRead,
    loading,
    // A failed list read used to be dropped on the floor here, so a 401, a
    // 429, a timeout and an offline laptop all rendered as "No tickets match
    // these filters." next to a green sync dot. The error is now carried to
    // the list body below.
    error: ticketsError,
    reload: reloadTickets,
  } = useAsync(() => listMyJiraTickets(), []);
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
  }, [fetchedRead]);

  const { data: fetchedProposal } = useAsync(() => getMyJiraProposal(), []);
  const [proposal, setProposal] = useState<JiraProposal | null>(null);
  useEffect(() => {
    if (fetchedProposal) setProposal(fetchedProposal);
  }, [fetchedProposal]);

  const { data: fetchedNudge, loading: nudgeLoading } = useAsync(
    () => getJiraDuplicateNudge(),
    [],
  );
  const [nudge, setNudge] = useState<JiraDuplicateNudge | null>(null);
  useEffect(() => {
    if (!nudgeLoading) setNudge(fetchedNudge ?? null);
  }, [nudgeLoading, fetchedNudge]);

  function updateTicket(updated: JiraTicket) {
    setTickets((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  function handleProposalResolved(updated: JiraProposal) {
    setProposal(updated);
    // Approving moves the real ticket's state — reflect it in the row this
    // page already has, exactly like every other write path here, rather
    // than a full refetch.
    if (updated.status === 'executed') {
      setTickets((ts) =>
        ts.map((t) =>
          t.id === updated.ticketId
            ? {
                ...t,
                stateName: updated.toStateName,
                stateColor: updated.toStateColor,
              }
            : t,
        ),
      );
    }
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

      <p className="mt-1.5 ml-[41px] max-w-[70ch] text-[12.5px] text-text-secondary">
        Everything assigned to you, reported by you, or watched by you — across{' '}
        <b>every</b> Jira project you can see, not one board.
        {/* The literal JQL that runs — parentheses included. JQL binds AND
            tighter than OR, so without them the Unresolved filter would apply
            to the watcher clause alone; see jiraClient.ts's MY_WORK_JQL. */}
        <span className="mt-1 block font-mono text-[11px] text-text-muted">
          (assignee = currentUser() OR reporter = currentUser() OR watcher =
          currentUser()) AND resolution = Unresolved
        </span>
      </p>

      <div className="mt-3.5 ml-[41px] flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={clsx(
              'cursor-pointer border-b-2 px-3 py-2 text-sm font-semibold transition-colors',
              tab === t.key
                ? 'border-accent text-text'
                : 'border-transparent text-text-muted hover:text-text-secondary',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'work' && (
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
                      Refresh — so it now says what actually happens. */}
                  {connection && <span>one API call · refresh to re-read</span>}
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

                <div className="mt-3 flex items-start gap-2 rounded-[var(--radius-sm)] border border-jira/30 bg-jira-bg px-3 py-2.5 text-[12.5px] text-jira">
                  <span>
                    Your own clicks write straight to Jira — no approval step,
                    ~400ms. Copilot&apos;s don&apos;t: see the rail.
                  </span>
                </div>
              </div>

              <CopilotRail
                proposal={proposal}
                onProposalResolved={handleProposalResolved}
                nudge={nudge}
                onOpenDrawer={setDrawerTicketId}
                onNudgeDismissed={() => setNudge(null)}
              />
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
