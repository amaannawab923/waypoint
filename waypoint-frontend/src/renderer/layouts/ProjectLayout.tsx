import { Outlet, useOutletContext, useParams, useNavigate } from 'react-router-dom';
import { useAsync } from '@/lib/useAsync';
import { getProject } from '@/data/api';
import type { Project } from '@/types/entities';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconGitBranch, IconSettings } from '@/components/icons';

export interface ProjectOutletContext {
  project: Project;
  reloadProject: () => void;
}

// docs/design/waypoint-revamp-mockup.html:791-796 — a project's own emoji,
// name, repo-link status, and a direct settings shortcut, sitting above
// every project-scoped screen (was: only reachable via Project Settings,
// several clicks deep, per the mockup's own `data-was` note on this row).
// Deliberately omits a branch/clean-dirty status the mockup's static demo
// shows ("· main · clean") — nothing in this app currently reads real git
// branch state, and fabricating one would be exactly the class of invented
// status this codebase's honesty pass exists to prevent.
function ProjectHeader({ project }: { project: Project }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-4">
      <span className="text-sm">{project.icon}</span>
      <span className="font-display text-sm font-semibold text-text">{project.name}</span>
      <button
        type="button"
        onClick={() => navigate(`/projects/${project.id}/settings/codebase`)}
        className="flex items-center gap-1.5 rounded-full border border-border bg-bg-inset px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text"
      >
        <IconGitBranch size={13} />
        {project.repoPath ? `Repo linked: ${project.repoPath}` : 'No repo linked — link one to ground Copilot'}
      </button>
      <button
        type="button"
        onClick={() => navigate(`/projects/${project.id}/settings/general`)}
        aria-label="Project settings"
        title="Project settings"
        className="ml-auto flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary hover:bg-surface-2 hover:text-text"
      >
        <IconSettings size={15} />
      </button>
    </div>
  );
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeader project={project} />
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
