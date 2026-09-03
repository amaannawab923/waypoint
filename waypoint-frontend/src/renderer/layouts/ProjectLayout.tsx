import { Outlet, useOutletContext, useParams } from 'react-router-dom';
import { useAsync } from '@/lib/useAsync';
import { getProject } from '@/data/api';
import type { Project } from '@/types/entities';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';

export interface ProjectOutletContext {
  project: Project;
  reloadProject: () => void;
}

/**
 * Resolves `:projectId` from the URL and provides the Project to every child
 * route via `useProject()`. Every project-scoped page (tickets, sprints,
 * workstreams, views, docs, requests, settings) is nested under this layout in
 * router.tsx — build against `useProject()` rather than re-fetching the
 * project yourself.
 */
export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const { data: project, loading, reload } = useAsync(() => getProject(projectId), [projectId]);

  if (loading && !project) {
    return (
      <Skeleton className="flex flex-col gap-2 p-4">
        <Skeleton.Block height="0.875rem" width="8rem" />
        <Skeleton.Block height="0.75rem" width="6rem" />
        <Skeleton.Block height="0.75rem" width="7rem" />
      </Skeleton>
    );
  }

  if (!project) {
    return <EmptyState title="Project not found" description="It may have been deleted or archived." />;
  }

  return <Outlet context={{ project, reloadProject: reload } satisfies ProjectOutletContext} />;
}

/** Use from any page nested under <ProjectLayout> in router.tsx to get the current project. */
export function useProject(): ProjectOutletContext {
  return useOutletContext<ProjectOutletContext>();
}
