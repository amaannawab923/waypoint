import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArchiveRestore, Trash2, PartyPopper } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { listArchivedProjects, listMembers, updateProject, deleteProject } from '@/mock/api';
import type { Project } from '@/types/entities';
import { Badge } from '@/components/ui/Badge';
import { AvatarStack } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/Button';
import { Skeleton, SkeletonCardGrid } from '@/components/ui/Skeleton';

export default function ArchivedProjects() {
  const { data: projects, loading, reload } = useAsync(() => listArchivedProjects(), []);
  const { data: members } = useAsync(() => listMembers(), []);
  const navigate = useNavigate();

  const memberById = useMemo(() => new Map((members ?? []).map((m) => [m.id, m])), [members]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-6">
        <h1 className="font-display text-xl font-medium text-text">Archived projects</h1>
        <p className="text-sm text-text-secondary">
          {projects ? (
            `${projects.length} archived project${projects.length === 1 ? '' : 's'}`
          ) : (
            <Skeleton className="inline-flex">
              <Skeleton.Block height="1rem" width="8rem" />
            </Skeleton>
          )}
        </p>
      </div>

      {loading && !projects && <SkeletonCardGrid />}

      {projects && projects.length === 0 && (
        <EmptyState
          icon={<PartyPopper size={32} strokeWidth={1.5} />}
          title="Looks like all your projects are still active—great job!"
          description="Projects you archive will show up here."
        />
      )}

      {projects && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ArchivedProjectCard
              key={project.id}
              project={project}
              memberById={memberById}
              onOpen={() => navigate(`/projects/${project.id}/work-items`)}
              onRestore={async () => {
                await updateProject(project.id, { archivedAt: null });
                reload();
              }}
              onDelete={async () => {
                if (window.confirm(`Permanently delete "${project.name}"? This can't be undone.`)) {
                  await deleteProject(project.id);
                  reload();
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ArchivedProjectCard({
  project,
  memberById,
  onOpen,
  onRestore,
  onDelete,
}: {
  project: Project;
  memberById: Map<string, { fullName: string; avatarColor: string }>;
  onOpen: () => void;
  onRestore: () => void;
  onDelete: () => void;
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
      className="group flex cursor-pointer flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-surface opacity-80 transition-opacity hover:opacity-100"
    >
      <div
        className="h-14 w-full grayscale"
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
              label="Restore project"
              onClick={(e) => {
                e.stopPropagation();
                onRestore();
              }}
            >
              <ArchiveRestore size={14} />
            </IconButton>
            <IconButton
              label="Delete project"
              className="hover:bg-danger-bg hover:text-danger"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        </div>

        {project.description && (
          <p className="line-clamp-2 text-xs text-text-secondary">{project.description}</p>
        )}

        <div className="mt-auto flex items-center justify-between pt-1">
          <AvatarStack people={people} size={22} max={4} />
          <Badge tone="neutral" outline>
            {project.network}
          </Badge>
        </div>
      </div>
    </div>
  );
}
