import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAsync } from '@/lib/useAsync';
import {
  getWorkspace,
  listProjects,
  getProposalCounts,
  listNotifications,
  listDraftTickets,
  detectLocalClaudeCode,
} from '@/data/api';
import { setProjects, upsertProjects, useAllProjects } from '@/lib/projectsStore';
import type { Project } from '@/types/entities';
import { CreateProjectModal } from '@/components/domain/CreateProjectModal';
import {
  IconHome,
  IconUser,
  IconBell,
  IconEdit,
  IconScratch,
  IconReview,
  IconPlus,
  IconFolder,
  IconLayers,
  IconList,
  IconRefresh,
  IconTrack,
  IconEye,
  IconInbox,
  IconFile,
  IconSettings,
  IconGitBranch,
  IconChevronRight,
  IconArchive,
  IconChart,
} from '@/components/icons';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-sm transition-colors',
    isActive
      ? 'bg-accent-soft-bg text-accent-soft-text font-medium'
      : 'text-text-secondary hover:bg-surface-2 hover:text-text',
  );

function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-semibold text-text-secondary">
      {count}
    </span>
  );
}

function AlertBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto rounded-full bg-danger-bg px-1.5 py-0.5 text-[10.5px] font-semibold text-danger">
      {count}
    </span>
  );
}

// A project's missing primitives are what "Add…" offers — per §3.4, creating
// one IS what makes its sidebar entry appear (lib/projectsStore.ts refreshes
// the row on every creation flow already), so this menu just routes to
// wherever that primitive's own "+ New" control lives rather than trying to
// create rows itself.
function AddMenu({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const options: { label: string; to: string }[] = [];
  if (project.primitiveCounts.sprints === 0) options.push({ label: 'New sprint', to: 'sprints' });
  if (project.primitiveCounts.workstreams === 0) options.push({ label: 'New workstream', to: 'workstreams' });
  if (project.primitiveCounts.views === 0) options.push({ label: 'New view', to: 'views' });
  if (project.primitiveCounts.docs === 0) options.push({ label: 'New doc', to: 'docs' });
  if (!project.acceptsRequests) options.push({ label: 'Enable requests', to: 'settings/general' });

  if (options.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        <IconPlus size={14} className="shrink-0" />
        Add…
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-0.5 min-w-[160px] rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.to}
              type="button"
              onClick={() => {
                setOpen(false);
                navigate(`/projects/${project.id}/${o.to}`);
              }}
              className="flex w-full items-center rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const navigate = useNavigate();
  const subNav: { to: string; label: string; icon: typeof IconList; count?: number }[] = [
    { to: 'tickets', label: 'Tickets', icon: IconList },
  ];
  // Nav presence is derived from whether the primitive actually has rows,
  // not a stored feature flag (docs/design/waypoint-revamp-architecture.md
  // §3.4) — a project with zero sprint rows shows no Sprints entry even if
  // it once did, and one with real rows shows it regardless of any past
  // toggle state. Requests is the one exception: it also shows when the
  // owner has turned on the request form, even before the first submission
  // arrives, since a project can accept requests before it has any.
  const { primitiveCounts } = project;
  if (primitiveCounts.sprints > 0) subNav.push({ to: 'sprints', label: 'Sprints', icon: IconRefresh });
  if (primitiveCounts.workstreams > 0) subNav.push({ to: 'workstreams', label: 'Workstreams', icon: IconTrack });
  if (primitiveCounts.views > 0) subNav.push({ to: 'views', label: 'Views', icon: IconEye });
  if (project.acceptsRequests || primitiveCounts.requests > 0) {
    subNav.push({ to: 'requests', label: 'Requests', icon: IconInbox, count: primitiveCounts.requests });
  }
  if (primitiveCounts.docs > 0) subNav.push({ to: 'docs', label: 'Docs', icon: IconFile });

  return (
    <div className="flex flex-col gap-0.5">
      <div className="group flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 text-sm text-text hover:bg-surface-2">
        <span className="shrink-0 text-sm">{project.icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
        <button
          type="button"
          onClick={() => navigate(`/projects/${project.id}/settings/general`)}
          aria-label={`${project.name} settings`}
          title="Project settings"
          className="flex size-5 shrink-0 items-center justify-center rounded text-text-muted opacity-0 group-hover:opacity-100 hover:bg-surface hover:text-text"
        >
          <IconSettings size={13} />
        </button>
      </div>

      <button
        type="button"
        onClick={() => navigate(`/projects/${project.id}/settings/codebase`)}
        className={clsx(
          'ml-1.5 flex h-6 items-center gap-1.5 truncate rounded-[var(--radius-sm)] px-1.5 text-left text-[11.5px] transition-colors hover:bg-surface-2',
          project.repoPath ? 'text-text-muted hover:text-text-secondary' : 'text-text-muted italic',
        )}
        title={project.repoPath ?? 'Link a repo'}
      >
        <IconGitBranch size={13} className="shrink-0" />
        <span className="truncate">{project.repoPath ?? 'Link a repo'}</span>
      </button>

      <div className="ml-1.5 flex flex-col gap-0.5 border-l border-border pl-2">
        {subNav.map((item) => (
          <NavLink key={item.to} to={`/projects/${project.id}/${item.to}`} className={navLinkClass}>
            <item.icon size={14} className="shrink-0" />
            <span className="truncate">{item.label}</span>
            {item.count !== undefined && <CountBadge count={item.count} />}
          </NavLink>
        ))}
        <AddMenu project={project} />
      </div>
    </div>
  );
}

function LocalStatusStrip() {
  const { data: projects } = useAsync(() => listProjects(), []);
  const { data: claude } = useAsync(() => detectLocalClaudeCode(), []);
  const navigate = useNavigate();

  const repoCount = (projects ?? []).filter((p) => p.repoPath).length;
  const claudeReady = claude?.state === 'present';

  return (
    <button
      type="button"
      onClick={() => navigate('/machine')}
      className="mx-2 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-success" />
      <span className="min-w-0 flex-1 truncate text-left">
        <b className="font-semibold text-text">Local</b> · {repoCount} repo{repoCount === 1 ? '' : 's'} ·{' '}
        {claudeReady ? 'Claude ready' : 'Claude not detected'}
      </span>
      <IconChevronRight size={14} className="shrink-0 text-text-muted" />
    </button>
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
  const { data: proposalCounts } = useAsync(() => getProposalCounts(), []);
  const { data: notifications } = useAsync(() => listNotifications(), []);
  const { data: drafts } = useAsync(() => listDraftTickets(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();

  const unreadCount = (notifications ?? []).filter((n) => !n.read).length;

  return (
    <aside className="thin-scroll flex h-full w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-inset">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent bg-[image:var(--accent-gradient)] text-on-accent shadow-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <polygon points="16,8 13,13 8,16 11,11" />
          </svg>
        </div>
        {workspace ? (
          <span className="truncate font-display text-sm font-semibold tracking-tight">{workspace.name}</span>
        ) : (
          <span className="h-3.5 w-20 animate-pulse rounded bg-surface-2" />
        )}
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        <NavLink to="/" end className={navLinkClass}>
          <IconHome size={15} />
          Home
        </NavLink>
        <NavLink to="/your-work" className={navLinkClass}>
          <IconUser size={15} />
          My work
        </NavLink>
        <NavLink to="/notifications" className={navLinkClass}>
          <IconBell size={15} />
          Notifications
          <CountBadge count={unreadCount} />
        </NavLink>
        <NavLink to="/drafts" className={navLinkClass}>
          <IconEdit size={15} />
          Drafts
          <CountBadge count={drafts?.length ?? 0} />
        </NavLink>
        <NavLink to="/scratchpad" className={navLinkClass}>
          <IconScratch size={15} />
          Scratchpad
        </NavLink>
      </nav>

      <div className="mx-2 my-3 border-t border-border" />

      <nav className="flex flex-col gap-0.5 px-2">
        <span className="px-2.5 pb-1 text-[10.5px] font-semibold tracking-wide text-text-muted uppercase">
          Agent output
        </span>
        {/* Propose->approve is the product's organising model (product
            strategy decision 2) — Review is where every proposal from every
            agent funnels through, so it gets its own labeled section rather
            than blending into the workspace-wide dashboards below. */}
        <NavLink to="/review" className={navLinkClass}>
          <IconReview size={15} />
          Review
          <AlertBadge count={proposalCounts?.proposed ?? 0} />
        </NavLink>
      </nav>

      <div className="mx-2 my-3 border-t border-border" />

      <div className="flex items-center justify-between px-4">
        <span className="text-[10.5px] font-semibold tracking-wide text-text-muted uppercase">Projects</span>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          aria-label="Add project"
          className="flex size-5 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
        >
          <IconPlus size={14} />
        </button>
      </div>
      <div className="mt-1 flex flex-col gap-0.5 px-2">
        <NavLink to="/projects" end className={navLinkClass}>
          <IconFolder size={15} />
          All projects
        </NavLink>
        {/* Was "Views" (opened a plain, unfiltered "All work items" table) —
            now the workspace scope of W5.2's unified TicketList: the same
            filter/group/search/bulk surface as a project's list, just with
            no project restriction (docs/design/waypoint-revamp-mockup.html:610). */}
        <NavLink to="/views" className={navLinkClass}>
          <IconLayers size={15} />
          All tickets
        </NavLink>
      </div>

      <div className="mt-2 flex flex-col gap-3 px-2">
        {projects?.map((p) => <ProjectRow key={p.id} project={p} />)}
      </div>

      <div className="flex-1" />

      <nav className="flex flex-col gap-0.5 px-2 py-3">
        <NavLink to="/projects/archived" className={navLinkClass}>
          <IconArchive size={15} />
          Archive
        </NavLink>
        <NavLink to="/analytics" className={navLinkClass}>
          <IconChart size={15} />
          Analytics
        </NavLink>
        <NavLink to="/settings/general" className={navLinkClass}>
          <IconSettings size={15} />
          Workspace settings
        </NavLink>
      </nav>

      <LocalStatusStrip />

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
