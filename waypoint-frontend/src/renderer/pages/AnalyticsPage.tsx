import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderKanban, ListTodo, RefreshCw, Boxes, FileText, Users, CheckCircle2 } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import {
  listProjects,
  listAllTickets,
  listWorkstreams,
  listSprints,
  listDocs,
  listMembers,
  listStates,
  getApprovedPerActiveDayStats,
} from '@/data/api';
import type { Project, Ticket, TicketState } from '@/types/entities';
import { Skeleton, SkeletonTableRows } from '@/components/ui/Skeleton';

interface ProjectAnalytics {
  project: Project;
  ticketCount: number;
  percentComplete: number;
}

async function loadAnalytics() {
  const [projects, tickets, members, approvedPerActiveDay] = await Promise.all([
    listProjects(),
    listAllTickets(),
    listMembers(),
    // W4.5 (architecture §4.2/§4.4, decision 10) — "proposals approved per
    // active day" is the metric that decides whether the whole
    // propose->approve thesis is real; independent of the per-project loop
    // below, so it loads alongside the other workspace-wide totals.
    getApprovedPerActiveDayStats(),
  ]);

  const perProject = await Promise.all(
    projects.map(async (project) => {
      const [workstreams, sprints, docs, states] = await Promise.all([
        listWorkstreams(project.id),
        listSprints(project.id),
        listDocs(project.id),
        listStates(project.id),
      ]);
      return { project, workstreams, sprints, docs, states };
    }),
  );

  const totalWorkstreams = perProject.reduce((sum, p) => sum + p.workstreams.length, 0);
  const totalSprints = perProject.reduce((sum, p) => sum + p.sprints.length, 0);
  const totalDocs = perProject.reduce((sum, p) => sum + p.docs.length, 0);

  const stateById = new Map<string, TicketState>();
  for (const p of perProject) {
    for (const s of p.states) stateById.set(s.id, s);
  }

  const itemsByProject = new Map<string, Ticket[]>();
  for (const item of tickets) {
    const list = itemsByProject.get(item.projectId) ?? [];
    list.push(item);
    itemsByProject.set(item.projectId, list);
  }

  const projectRows: ProjectAnalytics[] = perProject.map(({ project }) => {
    const items = itemsByProject.get(project.id) ?? [];
    const completed = items.filter((i) => stateById.get(i.stateId)?.group === 'completed').length;
    return {
      project,
      ticketCount: items.length,
      percentComplete: items.length === 0 ? 0 : Math.round((completed / items.length) * 100),
    };
  });

  return {
    totals: {
      projects: projects.length,
      tickets: tickets.length,
      sprints: totalSprints,
      workstreams: totalWorkstreams,
      docs: totalDocs,
      members: members.length,
    },
    approvedPerActiveDay,
    projectRows,
  };
}

export default function AnalyticsPage() {
  const { data, loading } = useAsync(() => loadAnalytics(), []);
  const navigate = useNavigate();

  const metrics = useMemo(
    () => [
      { label: 'Projects', value: data?.totals.projects, icon: FolderKanban },
      { label: 'Tickets', value: data?.totals.tickets, icon: ListTodo },
      { label: 'Sprints', value: data?.totals.sprints, icon: RefreshCw },
      { label: 'Workstreams', value: data?.totals.workstreams, icon: Boxes },
      { label: 'Docs', value: data?.totals.docs, icon: FileText },
      { label: 'Members', value: data?.totals.members, icon: Users },
    ],
    [data],
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-6">
        <h1 className="font-display text-xl font-medium text-text">Analytics</h1>
        <p className="text-sm text-text-secondary">Workspace-wide overview across every project.</p>
      </div>

      {loading && !data && (
        <>
          <Skeleton className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="rounded-[var(--radius)] border border-border bg-surface p-4">
                <Skeleton.Block height="1rem" width="1rem" className="mb-3" />
                <Skeleton.Block height="1.5rem" width="2.5rem" className="mb-1.5" />
                <Skeleton.Block height="0.75rem" width="4rem" />
              </div>
            ))}
          </Skeleton>

          <Skeleton className="mb-6 rounded-[var(--radius)] border border-border bg-surface p-4">
            <Skeleton.Block height="1rem" width="1rem" className="mb-3" />
            <Skeleton.Block height="1.5rem" width="3rem" className="mb-1.5" />
            <Skeleton.Block height="0.75rem" width="10rem" />
          </Skeleton>

          <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
            <div className="border-b border-border px-4 py-3">
              <h2 className="font-display text-sm font-medium text-text">Per-project breakdown</h2>
            </div>
            <SkeletonTableRows rows={4} columns={3} />
          </div>
        </>
      )}

      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {metrics.map((m) => (
              <div key={m.label} className="rounded-[var(--radius)] border border-border bg-surface p-4">
                <m.icon size={16} className="mb-3 text-text-muted" strokeWidth={2} />
                <p className="font-display text-2xl font-medium text-text">{m.value ?? 0}</p>
                <p className="text-xs text-text-secondary">{m.label}</p>
              </div>
            ))}
          </div>

          {/* Decision 10 (waypoint-product-strategy.md §11): "proposals
              approved per active day" is the metric that decides whether the
              propose->approve thesis is real — everything else on this page
              measures whether someone is using a tracker. All-time, not a
              rolling window (see getApprovedPerActiveDayStats's own comment
              for why), and honestly null — not 0 — until there is at least
              one active day of data. */}
          <div className="mb-6 rounded-[var(--radius)] border border-border bg-surface p-4">
            <CheckCircle2 size={16} className="mb-3 text-text-muted" strokeWidth={2} />
            {data.approvedPerActiveDay.averagePerActiveDay == null ? (
              <>
                <p className="font-display text-2xl font-medium text-text-muted">Not enough data yet</p>
                <p className="text-xs text-text-secondary">Proposals approved / active day</p>
              </>
            ) : (
              <>
                <p className="font-display text-2xl font-medium text-text">
                  {data.approvedPerActiveDay.averagePerActiveDay.toFixed(1)}
                </p>
                <p className="text-xs text-text-secondary">
                  Proposals approved / active day · {data.approvedPerActiveDay.approvedCount} approved over{' '}
                  {data.approvedPerActiveDay.activeDays} active{' '}
                  {data.approvedPerActiveDay.activeDays === 1 ? 'day' : 'days'}
                </p>
              </>
            )}
          </div>

          <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
            <div className="border-b border-border px-4 py-3">
              <h2 className="font-display text-sm font-medium text-text">Per-project breakdown</h2>
            </div>
            {data.projectRows.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-text-muted">No projects yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="px-4 py-2 font-medium">Project</th>
                    <th className="px-4 py-2 font-medium">Tickets</th>
                    <th className="px-4 py-2 font-medium">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projectRows.map(({ project, ticketCount, percentComplete }) => (
                    <tr
                      key={project.id}
                      onClick={() => navigate(`/projects/${project.id}/tickets`)}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="leading-none">{project.icon}</span>
                          <span className="font-medium text-text">{project.name}</span>
                          <span className="font-mono text-xs text-text-muted">{project.identifier}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{ticketCount}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-2">
                            <div
                              className="h-full rounded-full bg-accent"
                              style={{ width: `${percentComplete}%` }}
                            />
                          </div>
                          <span className="w-9 shrink-0 text-xs text-text-secondary">{percentComplete}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
