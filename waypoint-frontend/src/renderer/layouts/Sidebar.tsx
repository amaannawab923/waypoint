import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Home as HomeIcon,
  FileEdit,
  UserRound,
  StickyNote,
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
  Settings,
  Bot,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAsync } from '@/lib/useAsync';
import { getWorkspace, listProjects } from '@/mock/api';
import type { Project } from '@/types/entities';
import { CreateProjectModal } from '@/components/domain/CreateProjectModal';
import { AGENT_SESSIONS_ENABLED } from '@/lib/featureFlags';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-sm transition-colors',
    isActive ? 'bg-accent-soft-bg text-accent-soft-text font-medium' : 'text-text-secondary hover:bg-surface-2 hover:text-text',
  );

function ProjectRow({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const subNav: { to: string; label: string; icon: typeof LayoutList }[] = [
    { to: 'work-items', label: 'Work items', icon: LayoutList },
  ];
  if (project.features.cycles) subNav.push({ to: 'cycles', label: 'Cycles', icon: RefreshCw });
  if (project.features.modules) subNav.push({ to: 'modules', label: 'Modules', icon: Boxes });
  if (project.features.views) subNav.push({ to: 'views', label: 'Views', icon: Layers });
  if (project.features.pages) subNav.push({ to: 'pages', label: 'Pages', icon: FileText });
  if (project.features.intake) subNav.push({ to: 'intake', label: 'Intake', icon: Inbox });

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
  const { data: projects } = useAsync(() => listProjects(), []);
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
        <NavLink to="/your-work" className={navLinkClass}>
          <UserRound size={15} />
          Your work
        </NavLink>
        <NavLink to="/drafts" className={navLinkClass}>
          <FileEdit size={15} />
          Drafts
        </NavLink>
        <NavLink to="/stickies" className={navLinkClass}>
          <StickyNote size={15} />
          Stickies
        </NavLink>
        {AGENT_SESSIONS_ENABLED && (
          <NavLink to="/sessions" className={navLinkClass}>
            <Bot size={15} />
            Sessions
          </NavLink>
        )}
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
          Archives
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
        onCreated={(project) => navigate(`/projects/${project.id}/work-items`)}
      />
    </aside>
  );
}
