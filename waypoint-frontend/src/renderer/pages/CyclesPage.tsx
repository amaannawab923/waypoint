import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { listCycles, listStates, listWorkItems } from '@/mock/api';
import type { Cycle, WorkItem } from '@/types/entities';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { CycleStatsPanel } from '@/pages/cycles/CycleStatsPanel';
import { CycleListCard } from '@/pages/cycles/CycleListCard';
import { NewCycleForm } from '@/pages/cycles/NewCycleForm';
import { formatDateRange, getCycleStatus } from '@/pages/cycles/cycle-utils';

export default function CyclesPage() {
  const { project } = useProject();
  const [showForm, setShowForm] = useState(false);

  const {
    data: cycles,
    loading: cyclesLoading,
    reload: reloadCycles,
  } = useAsync(() => listCycles(project.id), [project.id]);
  const { data: items, loading: itemsLoading } = useAsync(() => listWorkItems(project.id), [project.id]);
  const { data: states, loading: statesLoading } = useAsync(() => listStates(project.id), [project.id]);

  const loading = cyclesLoading || itemsLoading || statesLoading;

  const itemsByCycle = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const item of items ?? []) {
      if (!item.cycleId) continue;
      const bucket = map.get(item.cycleId) ?? [];
      bucket.push(item);
      map.set(item.cycleId, bucket);
    }
    return map;
  }, [items]);

  const { active, upcoming, completed } = useMemo(() => {
    const buckets = { active: [] as Cycle[], upcoming: [] as Cycle[], completed: [] as Cycle[] };
    for (const cycle of cycles ?? []) {
      buckets[getCycleStatus(cycle)].push(cycle);
    }
    buckets.upcoming.sort((a, b) => a.startDate.localeCompare(b.startDate));
    buckets.completed.sort((a, b) => b.endDate.localeCompare(a.endDate));
    return buckets;
  }, [cycles]);

  if (!project.features.cycles) {
    return (
      <EmptyState
        icon={<RefreshCw size={28} />}
        title="Cycles isn't enabled for this project"
        description="Turn on the Cycles feature in project settings to plan work in time-boxed iterations."
        action={
          <Link
            to={`/projects/${project.id}/settings/features`}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-surface px-3 text-sm font-medium text-text transition-colors hover:bg-surface-2"
          >
            Go to feature settings
          </Link>
        }
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-lg font-medium text-text">Cycles</h1>
          <p className="text-sm text-text-muted">Time-boxed iterations for planning and tracking work.</p>
        </div>
        {!showForm && (
          <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
            <Plus size={14} />
            Add cycle
          </Button>
        )}
      </div>

      {showForm && (
        <NewCycleForm
          projectId={project.id}
          existingCycles={cycles ?? []}
          onCancel={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            reloadCycles();
          }}
        />
      )}

      {loading && (!cycles || !states) ? (
        <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-3">
          <SkeletonListRows rows={5} />
        </div>
      ) : (cycles ?? []).length === 0 ? (
        <EmptyState
          icon={<RefreshCw size={28} />}
          title="No cycles yet"
          description="Create your first cycle to start planning work in fixed time boxes."
        />
      ) : (
        <div className="flex flex-col gap-8">
          {active.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs font-medium tracking-wide text-text-muted uppercase">Active</h2>
              <div className="flex flex-col gap-4">
                {active.map((cycle) => (
                  <Link
                    key={cycle.id}
                    to={`/projects/${project.id}/cycles/${cycle.id}`}
                    className="block rounded-[var(--radius-lg)] border border-border-strong bg-surface p-5 transition-colors hover:bg-surface-2"
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-display text-base font-medium text-text">{cycle.name}</h3>
                          <Badge tone="accent">Active</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-text-muted">{formatDateRange(cycle.startDate, cycle.endDate)}</p>
                      </div>
                    </div>
                    <CycleStatsPanel cycle={cycle} items={itemsByCycle.get(cycle.id) ?? []} states={states ?? []} />
                  </Link>
                ))}
              </div>
            </section>
          )}

          {upcoming.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs font-medium tracking-wide text-text-muted uppercase">Upcoming</h2>
              <div className="flex flex-col gap-2">
                {upcoming.map((cycle) => (
                  <CycleListCard
                    key={cycle.id}
                    projectId={project.id}
                    cycle={cycle}
                    items={itemsByCycle.get(cycle.id) ?? []}
                    states={states ?? []}
                    allCycles={cycles ?? []}
                    onChanged={reloadCycles}
                  />
                ))}
              </div>
            </section>
          )}

          {completed.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs font-medium tracking-wide text-text-muted uppercase">Completed</h2>
              <div className="flex flex-col gap-2">
                {completed.map((cycle) => (
                  <CycleListCard
                    key={cycle.id}
                    projectId={project.id}
                    cycle={cycle}
                    items={itemsByCycle.get(cycle.id) ?? []}
                    states={states ?? []}
                    allCycles={cycles ?? []}
                    onChanged={reloadCycles}
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
