import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Home as HomeIcon,
  FileEdit,
  UserRound,
  NotepadText,
  FolderKanban,
  ChevronDown,
  ChevronRight,
  Plus,
  LayoutList,
  RefreshCw,
  Boxes,
  Layers,
  FileText,
  Inbox,
  Compass,
  Archive,
  BarChart2,
  ClipboardCheck,
  Settings,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAsync } from '@/lib/useAsync';
import { getWorkspace, listProjects } from '@/data/api';
import { setProjects, upsertProjects, useAllProjects } from '@/lib/projectsStore';
import type { Project } from '@/types/entities';
import { CreateProjectModal } from '@/components/domain/CreateProjectModal';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-sm transition-colors',
    isActive ? 'bg-accent-soft-bg text-accent-soft-text font-medium' : 'text-text-secondary hover:bg-surface-2 hover:text-text',
  );

function ProjectRow({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const subNav: { to: string; label: string; icon: typeof LayoutList }[] = [
    { to: 'tickets', label: 'Tickets', icon: LayoutList },
  ];
  // Nav presence is derived from whether the primitive actually has rows,
  // not a stored feature flag (docs/design/waypoint-revamp-architecture.md
  // §3.4) — a project with zero sprint rows shows no Sprints entry even if
  // it once did, and one with real rows shows it regardless of any past
  // toggle state. Requests is the one exception: it also shows when the
  // owner has turned on the request form, even before the first submission
  // arrives, since a project can accept requests before it has any.
  const { primitiveCounts } = project;
  if (primitiveCounts.sprints > 0) subNav.push({ to: 'sprints', label: 'Sprints', icon: RefreshCw });
  if (primitiveCounts.workstreams > 0) subNav.push({ to: 'workstreams', label: 'Workstreams', icon: Boxes });
  if (primitiveCounts.views > 0) subNav.push({ to: 'views', label: 'Views', icon: Layers });
  if (primitiveCounts.docs > 0) subNav.push({ to: 'docs', label: 'Docs', icon: FileText });
  if (project.acceptsRequests || primitiveCounts.requests > 0) {
    subNav.push({ to: 'requests', label: 'Requests', icon: Inbox });
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 text-sm text-text-secondary hover:bg-surface-2 hover:text-text"
      >
        {open ? <ChevronDown size={13} className="shrink-0 text-text-muted" /> : <ChevronRight size={13} className="shrink-0 text-text-muted" />}
        <span className="text-sm">{project.icon}</span>
        <span className="truncate font-medium text-text">{project.name}</span>
      </button>
      {open && (
        <div className="ml-4 flex flex-col gap-0.5 border-l border-border pl-2 py-0.5">
          {subNav.map((item) => (
            <NavLink key={item.to} to={`/projects/${project.id}/${item.to}`} className={navLinkClass}>
              <item.icon size={14} className="shrink-0" />
              <span className="truncate">{item.label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  // The initial fetch (for loading state) stays a plain useAsync — the
  // result seeds the shared projectsStore, and every render below reads
  // live from that store instead of this hook's own `data`, so a project
  // gaining its first sprint/workstream/view/doc/request from any other
  // mounted page (see lib/projectsStore.ts) updates this sidebar with no
  // reload of its own.
  useAsync(async () => {
    const rows = await listProjects();
    setProjects(rows);
    return rows;
  }, []);
  const projects = useAllProjects();
  const { data: workspace } = useAsync(() => getWorkspace(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <aside className="thin-scroll flex h-full w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-inset">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex size-6 items-center justify-center rounded-md bg-accent bg-[image:var(--accent-gradient)] text-on-accent shadow-sm">
          <Compass size={14} />
        </div>
        {workspace ? (
          <span className="font-display text-sm font-semibold tracking-tight truncate">{workspace.name}</span>
        ) : (
          <span className="h-3.5 w-20 animate-pulse rounded bg-surface-2" />
        )}
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        <NavLink to="/" end className={navLinkClass}>
          <HomeIcon size={15} />
          Home
        </NavLink>
        {/* Propose->approve is the product's organising model (product
            strategy decision 2) — Review is the workspace-wide "spine"
            screen every proposal from every agent funnels through, so it
            sits right under Home rather than down with the other
            workspace-wide dashboards. */}
        <NavLink to="/review" className={navLinkClass}>
          <ClipboardCheck size={15} />
          Review
        </NavLink>
        <NavLink to="/your-work" className={navLinkClass}>
          <UserRound size={15} />
          My work
        </NavLink>
        <NavLink to="/drafts" className={navLinkClass}>
          <FileEdit size={15} />
          Drafts
        </NavLink>
        <NavLink to="/scratchpad" className={navLinkClass}>
          <NotepadText size={15} />
          Scratchpad
        </NavLink>
      </nav>

      <div className="mt-5 flex items-center justify-between px-4">
        <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">Projects</span>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          aria-label="Add project"
          className="flex size-5 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="mt-1 flex flex-col gap-0.5 px-2">
        <NavLink to="/projects" end className={navLinkClass}>
          <FolderKanban size={15} />
          All projects
        </NavLink>
        {projects?.map((p) => <ProjectRow key={p.id} project={p} />)}
      </div>

      <div className="mt-auto flex flex-col gap-0.5 px-2 py-3">
        <NavLink to="/views" className={navLinkClass}>
          <Layers size={15} />
          Views
        </NavLink>
        <NavLink to="/projects/archived" className={navLinkClass}>
          <Archive size={15} />
          Archive
        </NavLink>
        <NavLink to="/analytics" className={navLinkClass}>
          <BarChart2 size={15} />
          Analytics
        </NavLink>
        <NavLink to="/settings/general" className={navLinkClass}>
          <Settings size={15} />
          Workspace settings
        </NavLink>
      </div>

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(project) => {
          upsertProjects([project]);
          navigate(`/projects/${project.id}/tickets`);
        }}
      />
    </aside>
  );
}
