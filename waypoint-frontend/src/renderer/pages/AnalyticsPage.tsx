import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderKanban, ListTodo, RefreshCw, Boxes, FileText, Users } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import {
  listProjects,
  listAllWorkItems,
  listModules,
  listCycles,
  listPages,
  listMembers,
  listStates,
} from '@/data/api';
import type { Project, WorkItem, WorkItemState } from '@/types/entities';
import { Skeleton, SkeletonTableRows } from '@/components/ui/Skeleton';

interface ProjectAnalytics {
  project: Project;
  workItemCount: number;
  percentComplete: number;
}

async function loadAnalytics() {
  const [projects, workItems, members] = await Promise.all([listProjects(), listAllWorkItems(), listMembers()]);

  const perProject = await Promise.all(
    projects.map(async (project) => {
      const [modules, cycles, pages, states] = await Promise.all([
        listModules(project.id),
        listCycles(project.id),
        listPages(project.id),
        listStates(project.id),
      ]);
      return { project, modules, cycles, pages, states };
    }),
  );

  const totalModules = perProject.reduce((sum, p) => sum + p.modules.length, 0);
  const totalCycles = perProject.reduce((sum, p) => sum + p.cycles.length, 0);
  const totalPages = perProject.reduce((sum, p) => sum + p.pages.length, 0);

  const stateById = new Map<string, WorkItemState>();
  for (const p of perProject) {
    for (const s of p.states) stateById.set(s.id, s);
  }

  const itemsByProject = new Map<string, WorkItem[]>();
  for (const item of workItems) {
    const list = itemsByProject.get(item.projectId) ?? [];
    list.push(item);
    itemsByProject.set(item.projectId, list);
  }

  const projectRows: ProjectAnalytics[] = perProject.map(({ project }) => {
    const items = itemsByProject.get(project.id) ?? [];
    const completed = items.filter((i) => stateById.get(i.stateId)?.group === 'completed').length;
    return {
      project,
      workItemCount: items.length,
      percentComplete: items.length === 0 ? 0 : Math.round((completed / items.length) * 100),
    };
  });

  return {
    totals: {
      projects: projects.length,
      workItems: workItems.length,
      cycles: totalCycles,
      modules: totalModules,
      pages: totalPages,
      members: members.length,
    },
    projectRows,
  };
}

export default function AnalyticsPage() {
  const { data, loading } = useAsync(() => loadAnalytics(), []);
  const navigate = useNavigate();

  const metrics = useMemo(
    () => [
      { label: 'Projects', value: data?.totals.projects, icon: FolderKanban },
      { label: 'Work items', value: data?.totals.workItems, icon: ListTodo },
      { label: 'Cycles', value: data?.totals.cycles, icon: RefreshCw },
      { label: 'Modules', value: data?.totals.modules, icon: Boxes },
      { label: 'Pages', value: data?.totals.pages, icon: FileText },
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
                    <th className="px-4 py-2 font-medium">Work items</th>
                    <th className="px-4 py-2 font-medium">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projectRows.map(({ project, workItemCount, percentComplete }) => (
                    <tr
                      key={project.id}
                      onClick={() => navigate(`/projects/${project.id}/work-items`)}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="leading-none">{project.icon}</span>
                          <span className="font-medium text-text">{project.name}</span>
                          <span className="font-mono text-xs text-text-muted">{project.identifier}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{workItemCount}</td>
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
