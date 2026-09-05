import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { JiraConnectionPanel } from '@/components/domain/JiraConnectionPanel';
import { jiraProjectColor } from '@/types/jira';
import type {
  JiraDuplicateNudge,
  JiraProjectKey,
  JiraProposal,
  JiraTicket,
  JiraTicketRole,
} from '@/types/jira';

type TabKey = 'work' | 'connection';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'work', label: 'My work' },
  { key: 'connection', label: 'Connection' },
];

const ROLE_FILTERS: { key: JiraTicketRole | 'all'; label: string }[] = [
  { key: 'all', label: 'Any role' },
  { key: 'assignee', label: 'Assigned' },
  { key: 'reporter', label: 'Reported' },
  { key: 'watcher', label: 'Watching' },
];

function FilterChip({
  active,
  onClick,
  swatch,
  children,
}: {
  active: boolean;
  onClick: () => void;
  swatch?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold whitespace-nowrap',
        active
          ? 'border-accent bg-accent-soft-bg text-accent-soft-text'
          : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-2',
      )}
    >
      {swatch && (
        <span
          className="size-2 shrink-0 rounded-sm"
          style={{ background: swatch }}
        />
      )}
      {children}
    </button>
  );
}

function LiveSyncIndicator({ lastSyncAt }: { lastSyncAt: string }) {
  // Re-renders once a second purely so the "synced Ns ago" label keeps
  // advancing. `lastSyncAt` is genuinely the moment the JQL search last ran
  // against the connected site, so this age is real — but nothing refreshes
  // it on a timer, which is exactly why the label reports an age rather than
  // implying a live stream.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
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
  const [projFilter, setProjFilter] = useState<JiraProjectKey | 'all'>('all');
  const [roleFilter, setRoleFilter] = useState<JiraTicketRole | 'all'>('all');
  const [drawerTicketId, setDrawerTicketId] = useState<string | null>(null);

  const connection = useLoadedJiraConnection();
  const { data: fetchedTickets, loading } = useAsync(
    () => listMyJiraTickets(),
    [],
  );
  const [tickets, setTickets] = useState<JiraTicket[]>([]);
  useEffect(() => {
    if (fetchedTickets) setTickets(fetchedTickets);
  }, [fetchedTickets]);

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

  // Derived from whatever the connected account can actually see, sorted for
  // a stable chip order. This used to iterate a hardcoded ['ENG','PLAT','GRW']
  // — the three fixture projects — which against a real site would have
  // rendered no project chips at all for anyone whose projects happen to be
  // called something else.
  const projectCounts = useMemo(() => {
    const counts = new Map<JiraProjectKey, number>();
    for (const t of tickets)
      counts.set(t.projectKey, (counts.get(t.projectKey) ?? 0) + 1);
    return counts;
  }, [tickets]);

  const projectKeys = useMemo(
    () => Array.from(projectCounts.keys()).sort((a, b) => a.localeCompare(b)),
    [projectCounts],
  );

  const filtered = useMemo(
    () =>
      tickets.filter(
        (t) =>
          (projFilter === 'all' || t.projectKey === projFilter) &&
          (roleFilter === 'all' || t.role === roleFilter),
      ),
    [tickets, projFilter, roleFilter],
  );

  const visibleProjectCount = new Set(filtered.map((t) => t.projectKey)).size;
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
          {loading && !fetchedTickets ? (
            <SkeletonListRows />
          ) : (
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1 basis-[460px]">
                <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
                  <FilterChip
                    active={projFilter === 'all'}
                    onClick={() => setProjFilter('all')}
                  >
                    All {tickets.length}
                  </FilterChip>
                  {projectKeys.map((key) => (
                    <FilterChip
                      key={key}
                      active={projFilter === key}
                      onClick={() => setProjFilter(key)}
                      swatch={jiraProjectColor(key)}
                    >
                      {key} {projectCounts.get(key)}
                    </FilterChip>
                  ))}
                  <span className="mx-1 h-4.5 w-px bg-border" />
                  {ROLE_FILTERS.map((r) => (
                    <FilterChip
                      key={r.key}
                      active={roleFilter === r.key}
                      onClick={() => setRoleFilter(r.key)}
                    >
                      {r.label}
                    </FilterChip>
                  ))}
                </div>

                <div className="mb-1.5 flex items-center justify-between gap-2.5 text-[11.5px] text-text-muted">
                  <span>
                    {filtered.length} issue{filtered.length === 1 ? '' : 's'} ·{' '}
                    {visibleProjectCount} Jira project
                    {visibleProjectCount === 1 ? '' : 's'}
                  </span>
                  {/* This used to read "polls every 15s". Nothing polls —
                      the list is read on mount and on the Connection tab's
                      Refresh — so it now says what actually happens. */}
                  {connection && <span>one API call · refresh to re-read</span>}
                </div>

                <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface shadow-sm">
                  {filtered.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-text-muted">
                      No tickets match these filters.
                    </div>
                  ) : (
                    filtered.map((ticket) => (
                      <JiraTicketRow
                        key={ticket.id}
                        ticket={ticket}
                        onOpenDrawer={setDrawerTicketId}
                        onTicketUpdated={updateTicket}
                        onResolveConflict={handleResolveConflict}
                        onDismissTombstone={handleDismissTombstone}
                      />
                    ))
                  )}
                </div>

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
            <JiraConnectionPanel connection={connection} />
          ) : (
            <SkeletonListRows />
          )}
        </div>
      )}

      {drawerTicket && (
        <JiraTicketDrawer
          ticket={drawerTicket}
          onClose={() => setDrawerTicketId(null)}
        />
      )}
    </div>
  );
}
