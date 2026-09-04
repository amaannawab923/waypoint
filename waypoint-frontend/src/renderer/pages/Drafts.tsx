import { Link } from 'react-router-dom';
import { IconEdit } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { listDraftTickets, listProjects } from '@/data/api';
import { EmptyState } from '@/components/ui/EmptyState';
import { PriorityIcon } from '@/components/domain/PriorityIcon';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { NotWired } from '@/components/ui/NotWired';

async function loadDrafts() {
  const [drafts, projects] = await Promise.all([listDraftTickets(), listProjects()]);
  return { drafts, projects };
}

export default function Drafts() {
  const { data, loading } = useAsync(() => loadDrafts(), []);

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-4xl p-6 md:p-8">
        <div className="rounded-[var(--radius-lg)] border border-border bg-surface">
          <SkeletonListRows rows={4} />
        </div>
      </div>
    );
  }
  if (!data) return null;

  const { drafts, projects } = data;

  return (
    <div className="mx-auto max-w-4xl p-6 md:p-8">
      <h1 className="font-display text-2xl font-medium text-text">Drafts</h1>
      <p className="mt-1 text-sm text-text-secondary">Tickets you started but haven't published yet.</p>

      <div className="mt-4">
        <NotWired capability="tickets.drafts" />
      </div>

      <div className="mt-6">
        {drafts.length === 0 ? (
          <EmptyState
            icon={<IconEdit size={28} />}
            title="Half-written tickets"
            description="Tickets you start but don't finish get auto-saved here, so you can pick up where you left off."
          />
        ) : (
          <div className="divide-y divide-border rounded-[var(--radius-lg)] border border-border bg-surface">
            {drafts.map((item) => {
              const project = projects.find((p) => p.id === item.projectId);
              return (
                <Link
                  key={item.id}
                  to={`/projects/${item.projectId}/tickets`}
                  className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-2"
                >
                  <PriorityIcon priority={item.priority} />
                  <span className="min-w-0 flex-1 truncate text-text">{item.title || 'Untitled'}</span>
                  <span className="shrink-0 truncate text-xs text-text-muted">{project?.name ?? 'Unknown project'}</span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
