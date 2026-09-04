import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpDown } from 'lucide-react';
import { IconSettings, IconPlus, IconArchive, IconFolder } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { listProjects, listMembers, archiveProject } from '@/data/api';
import type { Project } from '@/types/entities';
import { Button, IconButton } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { AvatarStack } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { CreateProjectModal } from '@/components/domain/CreateProjectModal';
import { Skeleton, SkeletonCardGrid } from '@/components/ui/Skeleton';

type SortKey = 'name' | 'created';
type VisibilityFilter = 'all' | 'public' | 'private';

export default function ProjectsList() {
  const { data: projects, loading, reload } = useAsync(() => listProjects(), []);
  const { data: members } = useAsync(() => listMembers(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('all');
  const navigate = useNavigate();

  const memberById = useMemo(() => new Map((members ?? []).map((m) => [m.id, m])), [members]);

  const visibleProjects = useMemo(() => {
    if (!projects) return [];
    const filtered =
      visibilityFilter === 'all' ? projects : projects.filter((p) => p.visibility === visibilityFilter);
    return [...filtered].sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name);
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [projects, visibilityFilter, sortKey]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-medium text-text">Projects</h1>
          <p className="text-sm text-text-secondary">
            {projects ? (
              `${projects.length} project${projects.length === 1 ? '' : 's'}`
            ) : (
              <Skeleton className="inline-flex">
                <Skeleton.Block height="1rem" width="4rem" />
              </Skeleton>
            )}
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <IconPlus size={15} />
          Add Project
        </Button>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-[var(--radius-sm)] border border-border-strong bg-surface p-0.5">
          {(['all', 'public', 'private'] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setVisibilityFilter(n)}
              className={
                'h-7 rounded-[calc(var(--radius-sm)-2px)] px-3 text-xs font-medium capitalize transition-colors ' +
                (visibilityFilter === n ? 'bg-accent text-on-accent' : 'text-text-secondary hover:text-text')
              }
            >
              {n}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setSortKey(sortKey === 'name' ? 'created' : 'name')}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-surface px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
        >
          <ArrowUpDown size={12} />
          Sort: {sortKey === 'name' ? 'Name' : 'Created date'}
        </button>
      </div>

      {loading && !projects && <SkeletonCardGrid />}

      {projects && visibleProjects.length === 0 && (
        <EmptyState
          icon={<IconFolder size={32} strokeWidth={1.5} />}
          title="No projects match this filter"
          description="Try a different visibility filter, or create a new project."
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <IconPlus size={15} />
              Add Project
            </Button>
          }
        />
      )}

      {visibleProjects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              memberById={memberById}
              onOpen={() => navigate(`/projects/${project.id}/tickets`)}
              onSettings={() => navigate(`/projects/${project.id}/settings`)}
              onArchive={async () => {
                await archiveProject(project.id);
                reload();
              }}
            />
          ))}
        </div>
      )}

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => reload()}
      />
    </div>
  );
}

function ProjectCard({
  project,
  memberById,
  onOpen,
  onSettings,
  onArchive,
}: {
  project: Project;
  memberById: Map<string, { fullName: string; avatarColor: string }>;
  onOpen: () => void;
  onSettings: () => void;
  onArchive: () => void;
}) {
  const people = project.memberIds.map((id) => {
    const m = memberById.get(id);
    return { name: m?.fullName ?? '?', color: m?.avatarColor };
  });

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-surface transition-colors hover:border-border-strong"
    >
      <div
        className="h-14 w-full"
        style={{ background: `linear-gradient(135deg, ${project.coverGradient[0]}, ${project.coverGradient[1]})` }}
      />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-lg leading-none">{project.icon}</span>
            <div className="min-w-0">
              <p className="truncate font-display text-sm font-medium text-text">{project.name}</p>
              <p className="font-mono text-xs text-text-muted">{project.identifier}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <IconButton
              label="Archive project"
              onClick={(e) => {
                e.stopPropagation();
                onArchive();
              }}
            >
              <IconArchive size={14} />
            </IconButton>
            <IconButton
              label="Project settings"
              onClick={(e) => {
                e.stopPropagation();
                onSettings();
              }}
            >
              <IconSettings size={14} />
            </IconButton>
          </div>
        </div>

        {project.description && (
          <p className="line-clamp-2 text-xs text-text-secondary">{project.description}</p>
        )}

        <div className="mt-auto flex items-center justify-between pt-1">
          <AvatarStack people={people} size={22} max={4} />
          <Badge tone={project.visibility === 'private' ? 'neutral' : 'accent'} outline>
            {project.visibility}
          </Badge>
        </div>
      </div>
    </div>
  );
}
