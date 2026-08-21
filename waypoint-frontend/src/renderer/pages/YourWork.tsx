import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListTodo, UserCheck2, Bell, Activity as ActivityIcon } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { getCurrentUser, listAllWorkItems, listProjects, listStates } from '@/mock/api';
import type { Member, Project, WorkItem, WorkItemState } from '@/types/entities';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { PriorityIcon, PRIORITY_ORDER, PRIORITY_LABEL } from '@/components/domain/PriorityIcon';
import { StateIcon, STATE_GROUP_LABEL } from '@/components/domain/StateIcon';
import type { StateGroup } from '@/types/entities';
import { SkeletonListRows } from '@/components/ui/Skeleton';

type TabKey = 'summary' | 'assigned' | 'created' | 'subscribed' | 'activity';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'created', label: 'Created' },
  { key: 'subscribed', label: 'Subscribed' },
  { key: 'activity', label: 'Activity' },
];

const WORKLOAD_GROUPS: StateGroup[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];

interface YourWorkData {
  user: Member;
  projects: Project[];
  assigned: WorkItem[];
  created: WorkItem[];
  states: WorkItemState[];
}

async function loadYourWork(): Promise<YourWorkData> {
  const [user, allItems, projects] = await Promise.all([getCurrentUser(), listAllWorkItems(), listProjects()]);
  const assigned = allItems.filter((w) => w.assigneeIds.includes(user.id));
  const created = allItems.filter((w) => w.createdById === user.id);
  const relevantProjectIds = Array.from(new Set([...assigned, ...created].map((w) => w.projectId)));
  const stateLists = await Promise.all(relevantProjectIds.map((pid) => listStates(pid)));
  return { user, projects, assigned, created, states: stateLists.flat() };
}

function projectName(projects: Project[], projectId: string): string {
  return projects.find((p) => p.id === projectId)?.name ?? 'Unknown project';
}

function WorkItemRow({
  item,
  projects,
  states,
}: {
  item: WorkItem;
  projects: Project[];
  states: WorkItemState[];
}) {
  const state = states.find((s) => s.id === item.stateId);
  return (
    <Link
      to={`/projects/${item.projectId}/work-items/${item.identifier}`}
      className="flex items-center gap-3 rounded-[var(--radius-sm)] px-2 py-2 text-sm transition-colors hover:bg-surface-2"
    >
      <PriorityIcon priority={item.priority} />
      {state && <StateIcon state={state} />}
      <span className="font-mono text-xs text-text-muted">{item.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-text">{item.title}</span>
      <span className="shrink-0 truncate text-xs text-text-muted">{projectName(projects, item.projectId)}</span>
    </Link>
  );
}

export default function YourWork() {
  const [tab, setTab] = useState<TabKey>('summary');
  const { data, loading } = useAsync(() => loadYourWork(), []);

  const byPriority = useMemo(() => {
    if (!data) return [] as { priority: (typeof PRIORITY_ORDER)[number]; items: WorkItem[] }[];
    return PRIORITY_ORDER.map((priority) => ({
      priority,
      items: data.assigned.filter((w) => w.priority === priority),
    })).filter((g) => g.items.length > 0);
  }, [data]);

  const workload = useMemo(() => {
    if (!data) return [] as { group: StateGroup; count: number }[];
    return WORKLOAD_GROUPS.map((group) => ({
      group,
      count: data.assigned.filter((w) => data.states.find((s) => s.id === w.stateId)?.group === group).length,
    }));
  }, [data]);

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-6xl p-6 md:p-8">
        <SkeletonListRows />
      </div>
    );
  }
  if (!data) return null;

  const { user, projects, assigned, created } = data;

  return (
    <div className="mx-auto max-w-6xl p-6 md:p-8">
      <h1 className="font-display text-2xl font-medium text-text">Your work</h1>

      <div className="mt-5 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              'cursor-pointer border-b-2 px-3 py-2 text-sm font-medium transition-colors ' +
              (tab === t.key
                ? 'border-accent text-text'
                : 'border-transparent text-text-secondary hover:text-text')
            }
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
                    <span className="text-xs font-medium tracking-wide uppercase">Created by you</span>
                  </div>
                  <p className="mt-2 font-display text-2xl font-medium text-text">{created.length}</p>
                </div>
                <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
                  <div className="flex items-center gap-2 text-text-secondary">
                    <UserCheck2 size={16} />
                    <span className="text-xs font-medium tracking-wide uppercase">Assigned to you</span>
                  </div>
                  <p className="mt-2 font-display text-2xl font-medium text-text">{assigned.length}</p>
                </div>
              </div>

              <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
                <h2 className="font-display text-sm font-medium text-text">Workload by state</h2>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {workload.map((w) => (
                    <div key={w.group} className="rounded-[var(--radius)] bg-surface-2 p-3 text-center">
                      <p className="font-display text-lg font-medium text-text">{w.count}</p>
                      <p className="mt-0.5 text-xs text-text-secondary">{STATE_GROUP_LABEL[w.group]}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
                <h2 className="font-display text-sm font-medium text-text">Assigned to you, by priority</h2>
                {byPriority.length === 0 ? (
                  <EmptyState title="Nothing assigned" description="Work items assigned to you will show up here." />
                ) : (
                  <div className="mt-2 space-y-4">
                    {byPriority.map((g) => (
                      <div key={g.priority}>
                        <p className="mb-1 text-xs font-medium text-text-secondary">{PRIORITY_LABEL[g.priority]}</p>
                        <div className="divide-y divide-border">
                          {g.items.map((item) => (
                            <WorkItemRow key={item.id} item={item} projects={projects} states={data.states} />
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
            <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
              {assigned.length === 0 ? (
                <EmptyState title="Nothing assigned" description="Work items assigned to you will show up here." />
              ) : (
                <div className="divide-y divide-border">
                  {assigned.map((item) => (
                    <WorkItemRow key={item.id} item={item} projects={projects} states={data.states} />
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'created' && (
            <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
              {created.length === 0 ? (
                <EmptyState title="Nothing created yet" description="Work items you create will show up here." />
              ) : (
                <div className="divide-y divide-border">
                  {created.map((item) => (
                    <WorkItemRow key={item.id} item={item} projects={projects} states={data.states} />
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'subscribed' && (
            <EmptyState
              icon={<Bell size={28} />}
              title="No subscriptions"
              description="Work items you subscribe to will show up here."
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
          <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-5 text-center">
            <Avatar name={user.fullName} color={user.avatarColor} size={56} className="mx-auto text-base" />
            <p className="mt-3 font-display text-sm font-medium text-text">{user.fullName}</p>
            <p className="text-xs text-text-secondary capitalize">{user.role}</p>
            <p className="mt-3 border-t border-border pt-3 text-xs text-text-muted">
              Joined {new Date(user.joinedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
