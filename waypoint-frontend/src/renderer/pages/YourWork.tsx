import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ListTodo,
  UserCheck2,
  Bell,
  Activity as ActivityIcon,
} from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { getCurrentUser } from '@/data/api';
import type { Member, StateGroup } from '@/types/entities';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  PriorityIcon,
  PRIORITY_ORDER,
  PRIORITY_LABEL,
} from '@/components/domain/PriorityIcon';
import { STATE_GROUP_LABEL } from '@/components/domain/StateIcon';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { useTicketsView } from '@/pages/tickets/useTicketsView';
import TicketListToolbar, {
  WORKSPACE_GROUP_BY_OPTIONS,
} from '@/pages/tickets/TicketListToolbar';
import TicketList from '@/pages/tickets/TicketList';

type TabKey = 'summary' | 'assigned' | 'created' | 'subscribed' | 'activity';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'created', label: 'Created' },
  { key: 'subscribed', label: 'Subscribed' },
  { key: 'activity', label: 'Activity' },
];

const WORKLOAD_GROUPS: StateGroup[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
];

/**
 * "My work" — the personal-scoped instance of W5.2's unified TicketList
 * (architecture §P5): same component as the project and workspace scopes,
 * default filter narrowed to the current user instead of narrowed to no
 * project. Assigned uses `{ assigneeId: ['@me'] }`, Created uses
 * `{ creatorId: ['@me'] }` — both server-side (§4.6's '@me' sentinel,
 * resolved in tickets.service.ts). Before W5.2 this page had its own
 * hand-rolled `TicketRow` and fetched every ticket in the workspace via
 * `listAllTickets()` just to filter it client-side down to two arrays; that
 * duplicate implementation (and the O(all tickets) fetch) is gone now that
 * this can just point the shared component at a different default filter.
 */
export default function YourWork() {
  const [tab, setTab] = useState<TabKey>('summary');
  const { data: user, loading: userLoading } = useAsync(
    () => getCurrentUser(),
    [],
  );

  const assignedView = useTicketsView({
    defaultFilters: { assigneeId: ['@me'] },
  });
  const createdView = useTicketsView({
    defaultFilters: { creatorId: ['@me'] },
  });

  const byPriority = useMemo(
    () =>
      PRIORITY_ORDER.map((priority) => ({
        priority,
        items: assignedView.items.filter((w) => w.priority === priority),
      })).filter((g) => g.items.length > 0),
    [assignedView.items],
  );

  const workload = useMemo(
    () =>
      WORKLOAD_GROUPS.map((group) => ({
        group,
        count: assignedView.items.filter(
          (w) => assignedView.stateFor(w)?.group === group,
        ).length,
      })),
    [assignedView],
  );

  if (userLoading && !user) {
    return (
      <div className="mx-auto max-w-6xl p-6 md:p-8">
        <SkeletonListRows />
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="mx-auto max-w-6xl p-6 md:p-8">
      <h1 className="font-display text-2xl font-medium text-text">My work</h1>

      <div className="mt-5 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`cursor-pointer border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'border-accent text-text'
                : 'border-transparent text-text-secondary hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6 flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-6">
          {tab === 'summary' && (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
                  <div className="flex items-center gap-2 text-text-secondary">
                    <ListTodo size={16} />
                    <span className="text-xs font-medium tracking-wide uppercase">
                      Created by you
                    </span>
                  </div>
                  <p className="mt-2 font-display text-2xl font-medium text-text">
                    {createdView.items.length}
                  </p>
                </div>
                <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
                  <div className="flex items-center gap-2 text-text-secondary">
                    <UserCheck2 size={16} />
                    <span className="text-xs font-medium tracking-wide uppercase">
                      Assigned to you
                    </span>
                  </div>
                  <p className="mt-2 font-display text-2xl font-medium text-text">
                    {assignedView.items.length}
                  </p>
                </div>
              </div>

              <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
                <h2 className="font-display text-sm font-medium text-text">
                  Workload by state
                </h2>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {workload.map((w) => (
                    <div
                      key={w.group}
                      className="rounded-[var(--radius)] bg-surface-2 p-3 text-center"
                    >
                      <p className="font-display text-lg font-medium text-text">
                        {w.count}
                      </p>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {STATE_GROUP_LABEL[w.group]}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
                <h2 className="font-display text-sm font-medium text-text">
                  Assigned to you, by priority
                </h2>
                {byPriority.length === 0 ? (
                  <EmptyState
                    title="Nothing assigned"
                    description="Tickets assigned to you will show up here."
                  />
                ) : (
                  <div className="mt-2 space-y-4">
                    {byPriority.map((g) => (
                      <div key={g.priority}>
                        <p className="mb-1 text-xs font-medium text-text-secondary">
                          {PRIORITY_LABEL[g.priority]}
                        </p>
                        <div className="divide-y divide-border">
                          {g.items.map((item) => (
                            <Link
                              key={item.id}
                              to={`/projects/${item.projectId}/tickets/${item.identifier}`}
                              className="flex items-center gap-3 rounded-[var(--radius-sm)] px-2 py-2 text-sm transition-colors hover:bg-surface-2"
                            >
                              <PriorityIcon priority={item.priority} />
                              <span className="font-mono text-xs text-text-muted">
                                {item.identifier}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-text">
                                {item.title}
                              </span>
                              <span className="shrink-0 truncate text-xs text-text-muted">
                                {assignedView.projectFor(item)?.name ??
                                  'Unknown project'}
                              </span>
                            </Link>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'assigned' && (
            <div className="rounded-[var(--radius-lg)] border border-border bg-surface">
              <div className="border-b border-border px-4 py-3">
                <TicketListToolbar
                  view={assignedView}
                  groupByOptions={WORKSPACE_GROUP_BY_OPTIONS}
                />
              </div>
              <TicketList view={assignedView} showProjectColumn />
            </div>
          )}

          {tab === 'created' && (
            <div className="rounded-[var(--radius-lg)] border border-border bg-surface">
              <div className="border-b border-border px-4 py-3">
                <TicketListToolbar
                  view={createdView}
                  groupByOptions={WORKSPACE_GROUP_BY_OPTIONS}
                />
              </div>
              <TicketList view={createdView} showProjectColumn />
            </div>
          )}

          {tab === 'subscribed' && (
            <EmptyState
              icon={<Bell size={28} />}
              title="No subscriptions"
              description="Tickets you subscribe to will show up here."
            />
          )}

          {tab === 'activity' && (
            <EmptyState
              icon={<ActivityIcon size={28} />}
              title="No recent activity"
              description="Your recent activity across the workspace will show up here."
            />
          )}
        </div>

        <aside className="w-full shrink-0 lg:w-64">
          <UserCard user={user} />
        </aside>
      </div>
    </div>
  );
}

function UserCard({ user }: { user: Member }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-5 text-center">
      <Avatar
        name={user.fullName}
        color={user.avatarColor}
        size={56}
        className="mx-auto text-base"
      />
      <p className="mt-3 font-display text-sm font-medium text-text">
        {user.fullName}
      </p>
      <p className="text-xs text-text-secondary capitalize">{user.role}</p>
      <p className="mt-3 border-t border-border pt-3 text-xs text-text-muted">
        Joined{' '}
        {new Date(user.joinedAt).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
        })}
      </p>
    </div>
  );
}
