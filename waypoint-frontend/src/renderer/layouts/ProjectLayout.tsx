import { Outlet, useOutletContext, useParams } from 'react-router-dom';
import { useAsync } from '@/lib/useAsync';
import { getProject } from '@/mock/api';
import type { Project } from '@/types/entities';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { RepoLinkBadge } from '@/components/domain/repo-link/RepoLinkBadge';

export interface ProjectOutletContext {
  project: Project;
  reloadProject: () => void;
}

/**
 * Resolves `:projectId` from the URL and provides the Project to every child
 * route via `useProject()`. Every project-scoped page (work items, cycles,
 * modules, views, pages, intake, settings) is nested under this layout in
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

  // The one per-project header this app has: every project-scoped page built
  // its own local header before this, with no shared row above them, which is
  // exactly why there was nowhere for a "grounded / not grounded" signal to
  // live. It wraps every project route including settings, whose own sidenav
  // shows the icon and name a second time — intentional duplication, matching
  // the design mockup, not an oversight.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-base leading-none">{project.icon}</span>
        <span className="font-display truncate text-sm font-medium text-text">{project.name}</span>
        <div className="flex-1" />
        <RepoLinkBadge project={project} onChanged={reload} />
      </div>
      <div className="min-h-0 flex-1">
        <Outlet context={{ project, reloadProject: reload } satisfies ProjectOutletContext} />
      </div>
    </div>
  );
}

/** Use from any page nested under <ProjectLayout> in router.tsx to get the current project. */
export function useProject(): ProjectOutletContext {
  return useOutletContext<ProjectOutletContext>();
}
