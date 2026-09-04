import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconPlus, IconRefresh } from '@/components/icons';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { listSprints, listStates, listTickets } from '@/data/api';
import { refreshProjectInStore } from '@/lib/projectsStore';
import type { Sprint, Ticket } from '@/types/entities';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { SprintStatsPanel } from '@/pages/sprints/SprintStatsPanel';
import { SprintListCard } from '@/pages/sprints/SprintListCard';
import { NewSprintForm } from '@/pages/sprints/NewSprintForm';
import { formatDateRange, getSprintStatus } from '@/pages/sprints/sprint-utils';

export default function SprintsPage() {
  const { project } = useProject();
  const [showForm, setShowForm] = useState(false);

  const {
    data: sprints,
    loading: sprintsLoading,
    reload: reloadSprints,
  } = useAsync(() => listSprints(project.id), [project.id]);
  const { data: items, loading: itemsLoading } = useAsync(() => listTickets(project.id), [project.id]);
  const { data: states, loading: statesLoading } = useAsync(() => listStates(project.id), [project.id]);

  const loading = sprintsLoading || itemsLoading || statesLoading;

  const itemsBySprint = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const item of items ?? []) {
      if (!item.sprintId) continue;
      const bucket = map.get(item.sprintId) ?? [];
      bucket.push(item);
      map.set(item.sprintId, bucket);
    }
    return map;
  }, [items]);

  const { active, upcoming, completed } = useMemo(() => {
    const buckets = { active: [] as Sprint[], upcoming: [] as Sprint[], completed: [] as Sprint[] };
    for (const sprint of sprints ?? []) {
      buckets[getSprintStatus(sprint)].push(sprint);
    }
    buckets.upcoming.sort((a, b) => a.startDate.localeCompare(b.startDate));
    buckets.completed.sort((a, b) => b.endDate.localeCompare(a.endDate));
    return buckets;
  }, [sprints]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-lg font-medium text-text">Sprints</h1>
          <p className="text-sm text-text-muted">Time-boxed iterations for planning and tracking work.</p>
        </div>
        {!showForm && (
          <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
            <IconPlus size={14} />
            Add sprint
          </Button>
        )}
      </div>

      {showForm && (
        <NewSprintForm
          projectId={project.id}
          existingSprints={sprints ?? []}
          onCancel={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            reloadSprints();
            // This may be the project's first sprint — refresh the shared
            // projects store so the sidebar's Sprints entry (driven by
            // primitiveCounts.sprints > 0) appears without a page reload.
            refreshProjectInStore(project.id);
          }}
        />
      )}

      {loading && (!sprints || !states) ? (
        <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-3">
          <SkeletonListRows rows={5} />
        </div>
      ) : (sprints ?? []).length === 0 ? (
        <EmptyState
          icon={<IconRefresh size={28} />}
          title="No sprints yet"
          description="Create a sprint to give a slice of work its own dates, lead, and status."
        />
      ) : (
        <div className="flex flex-col gap-8">
          {active.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs font-medium tracking-wide text-text-muted uppercase">Active</h2>
              <div className="flex flex-col gap-4">
                {active.map((sprint) => (
                  <Link
                    key={sprint.id}
                    to={`/projects/${project.id}/sprints/${sprint.id}`}
                    className="block rounded-[var(--radius-lg)] border border-border-strong bg-surface p-5 transition-colors hover:bg-surface-2"
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-display text-base font-medium text-text">{sprint.name}</h3>
                          <Badge tone="accent">Active</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-text-muted">{formatDateRange(sprint.startDate, sprint.endDate)}</p>
                      </div>
                    </div>
                    <SprintStatsPanel sprint={sprint} items={itemsBySprint.get(sprint.id) ?? []} states={states ?? []} />
                  </Link>
                ))}
              </div>
            </section>
          )}

          {upcoming.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs font-medium tracking-wide text-text-muted uppercase">Upcoming</h2>
              <div className="flex flex-col gap-2">
                {upcoming.map((sprint) => (
                  <SprintListCard
                    key={sprint.id}
                    projectId={project.id}
                    sprint={sprint}
                    items={itemsBySprint.get(sprint.id) ?? []}
                    states={states ?? []}
                    allSprints={sprints ?? []}
                    onChanged={reloadSprints}
                  />
                ))}
              </div>
            </section>
          )}

          {completed.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs font-medium tracking-wide text-text-muted uppercase">Completed</h2>
              <div className="flex flex-col gap-2">
                {completed.map((sprint) => (
                  <SprintListCard
                    key={sprint.id}
                    projectId={project.id}
                    sprint={sprint}
                    items={itemsBySprint.get(sprint.id) ?? []}
                    states={states ?? []}
                    allSprints={sprints ?? []}
                    onChanged={reloadSprints}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
