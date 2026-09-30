import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAsync } from '@/lib/useAsync';
import {
  getWorkspace,
  listProjects,
  listReviewQueue,
} from '@/data/api';
import {
  setProjects,
  upsertProjects,
  useAllProjects,
} from '@/lib/projectsStore';
import { upsertProposals, usePendingProposalCount } from '@/lib/proposalStore';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import { useWaitingSessionsCount } from '@/lib/sessionsStore';
import { useLocalSummary } from '@/lib/useLocalSummary';
import { MY_JIRA_ENABLED, SESSIONS_ENABLED } from '@/lib/featureFlags';
import {
  activeProjectIdFrom,
  isProjectOpen,
  setProjectOpen,
  useSidebarProjectChoices,
} from '@/lib/sidebarProjects';
import type { Project } from '@/types/entities';
import { CreateProjectModal } from '@/components/domain/CreateProjectModal';
import { AddProjectWizard } from '@/components/domain/AddProjectWizard';
import { JiraMark } from '@/components/domain/JiraMark';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  IconHome,
  IconUser,
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
  IconBot,
  IconChevron,
} from '@/components/icons';

/**
 * The one sidebar (ROAD-159, docs/design/shell-ux-v3.md): always mounted at
 * one of two widths, decided by the single global `pinned` boolean AppShell
 * owns (`waypoint:sidebarPinned`) — never by the route. Unpinned renders the
 * 56px icon rail (RAIL_WIDTH_PX); pinned renders the 256px panel
 * (SIDEBAR_WIDTH_PX). AppShell's `data-sidebar-column` wrapper owns the
 * width and the 150ms tween; this component fills whatever width it's
 * given and switches its own internal layout on `pinned`.
 *
 * This replaces the former Sidebar.tsx (always the panel) + SidebarRail.tsx
 * (always the rail, mounted only inside the old route-gated "focus
 * workspace") as two files that happened to agree on colors and copy.
 * There's one `NavRow` and one `Badge` below, each declared once and
 * rendered differently depending on `pinned` — not two components
 * maintained in parallel.
 */

export const RAIL_WIDTH_PX = 56;
/** Sidebar's panel width, pinned. */
export const SIDEBAR_WIDTH_PX = 256;
export const PEEK_DELAY_MS = 200;
/** More projects than this fold into "All projects & tickets" in the rail's flyout. */
const FLYOUT_MAX_PROJECTS = 6;

/** §4.3: two icon sizes, declared once — 16px for anything that is a
 *  primary nav target (top-level rows, rail items), 13px for anything
 *  secondary (sub-nav rows, the settings gear, chevrons, inline
 *  affordances). No other size appears in this file. */
const ICON_PRIMARY = 16;
const ICON_SECONDARY = 13;

// §4.5's four-step spacing scale, applied with a stated rule: `my-3`/`gap-3`
// (12px) separates labeled groups — the hairline dividers between the top
// nav, Review, and Projects sections below; `gap-1`/`mt-1` (4px) sits
// between related rows inside one group. Row height/padding (32px/8px) is
// unchanged — it was already fine. No other spacing value appears in this
// file's layout.

/** §4.2: one active treatment, applied everywhere something is "current" —
 *  top nav, rail items, and the folded-project row alike. No second
 *  ("bg-surface-2/60"-style) active state survives this file. */
const ACTIVE_CLASS = 'bg-accent-soft-bg text-accent-soft-text font-medium';

/** What the pin control expands and collapses, named so the button can say
 *  so via aria-controls. The DEFAULT only — AppShell mounts a second
 *  Sidebar for the peek overlay while the rail's own is still mounted, and
 *  two elements sharing one id is invalid HTML that makes getElementById
 *  (and assistive tech) resolve every aria-controls to whichever comes
 *  first in document order — the rail underneath, not the peek panel the
 *  peek's own button sits inside. That mount passes its own id. */
const SIDEBAR_NAV_ID = 'waypoint-sidebar-nav';

/** The one visual primitive this pass left to the UA default. Declared here
 *  for the same reason the icon, spacing and badge scales are: so keyboard
 *  focus looks deliberate, and looks the same on every control in the file
 *  rather than whatever Chromium draws. */
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg-inset';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-sm transition-colors',
    FOCUS_RING,
    isActive
      ? ACTIVE_CLASS
      : 'text-text-secondary hover:bg-surface-2 hover:text-text',
  );

const railLinkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'relative mx-auto flex size-9 items-center justify-center rounded-[var(--radius)] transition-colors',
    FOCUS_RING,
    isActive
      ? ACTIVE_CLASS
      : 'text-text-secondary hover:bg-surface-2 hover:text-text',
  );

interface BadgeSpec {
  count: number;
  tone?: 'neutral' | 'alert';
  /** `atLeast` renders the count as a floor ("500+") — only meaningful
   *  inline; a floating rail badge never has the room for it. */
  atLeast?: boolean;
}

/** §4.4: one badge component. `context` (inline in a panel row vs floating
 *  over a rail icon) comes from the ancestor's width, never chosen per
 *  call site; `tone` is the only thing a caller picks. */
function Badge({
  count,
  tone = 'neutral',
  atLeast = false,
  context,
}: BadgeSpec & { context: 'inline' | 'floating' }) {
  if (count <= 0) return null;
  return (
    <span
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-full font-bold',
        context === 'inline'
          ? 'ml-auto px-1.5 py-0.5 text-[10.5px]'
          : 'absolute -top-0.5 -right-0.5 h-[15px] min-w-[15px] px-1 text-[9px] ring-2 ring-bg-inset',
        tone === 'alert'
          ? context === 'floating'
            ? 'bg-danger text-white'
            : 'bg-danger-bg text-danger'
          : 'bg-surface-2 text-text-secondary',
      )}
    >
      {count}
      {atLeast ? '+' : ''}
    </span>
  );
}

/**
 * One nav row, rendered two ways depending on `pinned` — a 36px icon
 * button (rail) or a full labeled row (panel) — instead of two components
 * that happen to agree on destination, color and badge.
 */
function NavRow({
  pinned,
  to,
  end,
  icon: Icon,
  label,
  railLabel,
  badge,
}: {
  pinned: boolean;
  to: string;
  end?: boolean;
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  /** Tooltip/aria-label text when the rail icon needs more context than
   *  the label alone (e.g. a waiting count) — defaults to `label`. */
  railLabel?: string;
  badge?: BadgeSpec;
}) {
  if (!pinned) {
    const tip = railLabel ?? label;
    return (
      <Tooltip label={tip}>
        <NavLink to={to} end={end} aria-label={tip} className={railLinkClass}>
          <Icon size={ICON_PRIMARY} />
          {badge && (
            <Badge
              count={badge.count}
              tone={badge.tone}
              context="floating"
            />
          )}
        </NavLink>
      </Tooltip>
    );
  }

  return (
    <NavLink to={to} end={end} className={navLinkClass}>
      <Icon size={ICON_PRIMARY} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge && (
        <Badge
          count={badge.count}
          tone={badge.tone}
          atLeast={badge.atLeast}
          context="inline"
        />
      )}
    </NavLink>
  );
}

// A project's missing primitives are what "Add…" offers — per §3.4, creating
// one IS what makes its sidebar entry appear (lib/projectsStore.ts refreshes
// the row on every creation flow already), so this menu just routes to
// wherever that primitive's own "+ New" control lives rather than trying to
// create rows itself. Panel-only — the rail never renders a project's
// sub-nav at all (its projects are one flyout icon, see ProjectsFlyout).
function AddMenu({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const options: { label: string; to: string }[] = [];
  if (project.primitiveCounts.sprints === 0)
    options.push({ label: 'New sprint', to: 'sprints' });
  if (project.primitiveCounts.workstreams === 0)
    options.push({ label: 'New workstream', to: 'workstreams' });
  if (project.primitiveCounts.views === 0)
    options.push({ label: 'New view', to: 'views' });
  if (project.primitiveCounts.docs === 0)
    options.push({ label: 'New doc', to: 'docs' });
  if (!project.acceptsRequests)
    options.push({ label: 'Enable requests', to: 'settings/general' });

  if (options.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        <IconPlus size={ICON_SECONDARY} className="shrink-0" />
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
  // Folded by default (founder, 2026-09-21: four seeded projects' sub-navs
  // covered the whole rail). The project the route is inside shows open
  // unless it was folded by hand; a fold or unfold is remembered.
  const { pathname } = useLocation();
  const choices = useSidebarProjectChoices();
  const activeId = activeProjectIdFrom(pathname);
  const open = isProjectOpen(choices, project.id, activeId);
  const isActive = activeId === project.id;
  const subNav: {
    to: string;
    label: string;
    icon: typeof IconList;
    count?: number;
  }[] = [{ to: 'tickets', label: 'Tickets', icon: IconList }];
  // Nav presence is derived from whether the primitive actually has rows,
  // not a stored feature flag (docs/design/waypoint-revamp-architecture.md
  // §3.4) — a project with zero sprint rows shows no Sprints entry even if
  // it once did, and one with real rows shows it regardless of any past
  // toggle state. Requests is the one exception: it also shows when the
  // owner has turned on the request form, even before the first submission
  // arrives, since a project can accept requests before it has any.
  const { primitiveCounts } = project;
  if (primitiveCounts.sprints > 0)
    subNav.push({ to: 'sprints', label: 'Sprints', icon: IconRefresh });
  if (primitiveCounts.workstreams > 0)
    subNav.push({ to: 'workstreams', label: 'Workstreams', icon: IconTrack });
  if (primitiveCounts.views > 0)
    subNav.push({ to: 'views', label: 'Views', icon: IconEye });
  if (project.acceptsRequests || primitiveCounts.requests > 0) {
    // The badge counts only pending (actionable) requests — the same
    // "actionable, not historical total" rule Review's badge already
    // follows above — while the nav item itself still shows
    // based on the total (primitiveCounts.requests), so a project with only
    // resolved requests in its history doesn't lose its Requests entry.
    subNav.push({
      to: 'requests',
      label: 'Requests',
      icon: IconInbox,
      count: primitiveCounts.requestsPending,
    });
  }
  if (primitiveCounts.docs > 0)
    subNav.push({ to: 'docs', label: 'Docs', icon: IconFile });

  const Chevron = open ? IconChevron : IconChevronRight;
  return (
    <div className="flex flex-col gap-1" data-project-row={project.id}>
      <div
        className={clsx(
          'group flex h-8 items-center gap-1 rounded-[var(--radius-sm)] pr-1.5 pl-0.5 text-sm hover:bg-surface-2',
          isActive && !open ? ACTIVE_CLASS : 'text-text',
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Fold' : 'Unfold'} ${project.name}`}
          onClick={() => setProjectOpen(project.id, !open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left"
        >
          <Chevron size={ICON_SECONDARY} className="shrink-0 text-text-muted" />
          <span className="shrink-0 text-sm">{project.icon}</span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {project.name}
          </span>
          {/* Folded, what still needs a person is not hidden with it. */}
          {!open && (
            <Badge
              count={primitiveCounts.requestsPending}
              context="inline"
            />
          )}
        </button>
        <button
          type="button"
          onClick={() => navigate(`/projects/${project.id}/settings/general`)}
          aria-label={`${project.name} settings`}
          title="Project settings"
          className="flex size-5 shrink-0 items-center justify-center rounded text-text-muted opacity-0 group-hover:opacity-100 hover:bg-surface hover:text-text"
        >
          <IconSettings size={ICON_SECONDARY} />
        </button>
      </div>

      {open && (
        <>
          <button
            type="button"
            onClick={() =>
              navigate(`/projects/${project.id}/settings/codebase`)
            }
            className={clsx(
              'ml-1.5 flex h-6 items-center gap-1.5 truncate rounded-[var(--radius-sm)] px-1.5 text-left text-[11.5px] transition-colors hover:bg-surface-2',
              project.repoPath
                ? 'text-text-muted hover:text-text-secondary'
                : 'text-text-muted italic',
            )}
            title={project.repoPath ?? 'Link a repo'}
          >
            <IconGitBranch size={ICON_SECONDARY} className="shrink-0" />
            <span className="truncate">
              {project.repoPath ?? 'Link a repo'}
            </span>
          </button>

          <div className="ml-1.5 flex flex-col gap-1 border-l border-border pl-2">
            {subNav.map((item) => (
              <NavLink
                key={item.to}
                to={`/projects/${project.id}/${item.to}`}
                className={navLinkClass}
              >
                <item.icon size={ICON_SECONDARY} className="shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.count !== undefined && (
                  <Badge count={item.count} context="inline" />
                )}
              </NavLink>
            ))}
            <AddMenu project={project} />
          </div>
        </>
      )}
    </div>
  );
}

/** Projects fold into one icon in the rail; hovering (or focusing) it lists
 *  them — the rail's only replacement for the panel's full project tree.
 *  Left disagreeing with the panel's own "more projects exist" affordance
 *  per shell-ux-v3.md §4.7 (a follow-up once both share one data path). */
function ProjectsFlyout() {
  const projects = useAllProjects();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const shown = projects.slice(0, FLYOUT_MAX_PROJECTS);
  const hidden = projects.length - shown.length;

  return (
    <div
      className="relative"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={show}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          hideSoon();
      }}
    >
      <NavLink
        to="/projects"
        className={railLinkClass}
        aria-label="Projects"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconFolder size={ICON_PRIMARY} />
      </NavLink>
      {open && (
        <div
          role="menu"
          aria-label="Projects"
          className="absolute top-0 left-full z-40 ml-1.5 min-w-[176px] rounded-[var(--radius)] border border-border bg-surface p-1 shadow-lg"
        >
          <div className="px-2 pt-1 pb-1.5 text-[10px] font-bold tracking-wide text-text-muted uppercase">
            Projects
          </div>
          {shown.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate(`/projects/${project.id}/tickets`);
              }}
              className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2"
            >
              <span className="shrink-0 text-sm">{project.icon}</span>
              <span className="truncate">{project.name}</span>
            </button>
          ))}
          {shown.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-text-muted">
              No projects yet
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              navigate('/projects');
            }}
            className="mt-1 flex w-full items-center gap-2 rounded-[var(--radius-sm)] border-t border-border px-2 pt-2 pb-1.5 text-left text-sm text-text-secondary hover:bg-surface-2"
          >
            <IconFolder size={ICON_SECONDARY} className="shrink-0 text-text-muted" />
            {/* Was "All projects & tickets" -> /views. "All tickets" now has
                its own rail icon directly below this flyout, so routing here
                too made one destination reachable twice from adjacent
                controls. This footer's remaining job is the projects the
                list above had no room for. */}
            <span className="truncate">
              All projects{hidden > 0 ? ` (+${hidden} more)` : ''}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/** My Jira's icon isn't from the shared icon set (JiraMark is its own SVG
 *  mark) — this adapts it to the same `{ size, className }` shape NavRow's
 *  `icon` prop expects, so My Jira renders through the same NavRow every
 *  other top-level destination does instead of a bespoke row. */
function JiraNavIcon({ size, className }: { size?: number; className?: string }) {
  return (
    <span className={clsx('flex items-center justify-center text-jira', className)}>
      <JiraMark size={size} />
    </span>
  );
}

/**
 * "My Jira" companion project's own nav slot — deliberately not a
 * ProjectRow: My Jira isn't a row in projectsStore (see types/jira.ts's own
 * header comment on why it's modeled as a standalone concept), it's a
 * single flat link, closer to the "All tickets"/"All projects" rows than to
 * a real project's sub-nav tree. Renders nothing when the flag is off or
 * the connection isn't connected — no broken/disabled nav item for a
 * surface that isn't reachable. Appears in the rail once connected, like
 * every other destination — the rail carries the whole nav, not a subset.
 */
function MyJiraNavRow({ pinned }: { pinned: boolean }) {
  // The flag is checked before the hook, not after it. `useLoadedJiraConnection`
  // fetches on mount, so checking afterwards meant a flag-off build still made
  // an IPC round trip and a credential-file read on every launch before
  // rendering nothing — a build with the feature disabled was not quite
  // identical to one without the feature, which is the whole promise of the
  // flag. Returning before any hook runs is safe here precisely because
  // MY_JIRA_ENABLED is a build-time constant: it cannot change between
  // renders, so this can never vary the hook order within a build.
  if (!MY_JIRA_ENABLED) return null;
  return <MyJiraNavRowInner pinned={pinned} />;
}

function MyJiraNavRowInner({ pinned }: { pinned: boolean }) {
  const connection = useLoadedJiraConnection();
  if (!connection?.connected) return null;
  // A capped read renders "500+", not "500". The badge is a glance, and a
  // glance that says a precise wrong number is worse than one that says "at
  // least this many". The number is what is ASSIGNED to the user (Fix 9) —
  // the union total read as "needs your attention" while meaning "anything
  // you touch"; the Assigned tab says the same number.
  const count = connection.assignedCount ?? connection.issueCount;
  return (
    <NavRow
      pinned={pinned}
      to="/my-jira"
      icon={JiraNavIcon}
      label="My Jira"
      railLabel={`My Jira · ${count} assigned`}
      badge={{ count, atLeast: connection.countsTruncated }}
    />
  );
}

/**
 * "My sessions" — the user's own agent runs on this machine (W3, ROAD-58),
 * directly under My work. The badge is the number of runs waiting on the
 * user (blocked + needs-review), read live off lib/sessionsStore.ts.
 * Flag-gated at the component boundary for the same reason MyJiraNavRow is.
 * Part of the rail's fixed destination set (shell-ux-v3.md §3).
 */
function MySessionsNavRow({ pinned }: { pinned: boolean }) {
  if (!SESSIONS_ENABLED) return null;
  return <MySessionsNavRowInner pinned={pinned} />;
}

function MySessionsNavRowInner({ pinned }: { pinned: boolean }) {
  const waiting = useWaitingSessionsCount();
  return (
    <NavRow
      pinned={pinned}
      to="/sessions"
      icon={IconBot}
      label="My sessions"
      railLabel={
        waiting > 0 ? `My sessions · ${waiting} waiting on you` : 'My sessions'
      }
      badge={{ count: waiting, tone: 'alert' }}
    />
  );
}

export interface SidebarProps {
  /** True renders the 256px panel (full nav, labels); false renders the
   *  56px icon rail. The only thing that ever decides this is AppShell's
   *  global pin state — never the route. */
  pinned: boolean;
  /** The id this mount puts on its scroll region, which its own pin control
   *  names via aria-controls. Defaults to the single-mount case; the peek
   *  overlay must pass its own so the two mounts stay distinguishable. */
  navId?: string;
  /** Rail only: the pointer rested on the expand affordance long enough —
   *  AppShell shows the peek overlay. */
  onPeek?: () => void;
  /** Rail only: the pointer left the expand affordance. */
  onPeekEnd?: () => void;
  /** The affordance's click — the rail's expand control or the panel's
   *  collapse control, the same handler either way, since both just flip
   *  the one pin. */
  onTogglePin: () => void;
  /** The peek overlay is open: the rail affordance's own tooltip would sit
   *  on top of it. */
  peeking?: boolean;
}

export function Sidebar({
  pinned,
  navId = SIDEBAR_NAV_ID,
  onPeek,
  onPeekEnd,
  onTogglePin,
  peeking = false,
}: SidebarProps) {
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
  // Seeds the shared proposalStore with the workspace-wide 'proposed' queue
  // once on mount — the same fetch useReviewQueue makes for the Review
  // screen's own 'proposed' segment (lib/useReviewQueue.ts), capped at the
  // backend's own MAX_REVIEW_QUEUE_LIMIT (proposals.service.ts) rather than
  // its default page size, since this seed's only job is to make the count
  // correct, not to page through results — then reads the badge count live
  // off that store via usePendingProposalCount below.
  useAsync(async () => {
    const { proposals } = await listReviewQueue({
      status: 'proposed',
      limit: 100,
    });
    upsertProposals(proposals);
  }, []);
  const pendingProposalCount = usePendingProposalCount();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const { repoCount, claudeReady, sentence: localSummary } =
    useLocalSummary();
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      if (peekTimer.current) clearTimeout(peekTimer.current);
    },
    [],
  );

  return (
    <aside
      id={navId}
      className={clsx(
        'thin-scroll flex h-full w-full shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-inset',
        pinned && 'overflow-x-hidden',
      )}
    >
      {/* §4.6: a full-bleed hairline under the header row, in both the
          panel and the rail — there used to be no separation at all. */}
      <div
        className={clsx(
          'flex shrink-0 items-center border-b border-border',
          pinned ? 'gap-2 px-4 py-[13px]' : 'flex-col gap-2.5 py-[13px]',
        )}
      >
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent bg-[image:var(--accent-gradient)] text-on-accent shadow-sm">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <polygon points="16,8 13,13 8,16 11,11" />
          </svg>
        </div>
        {pinned ? (
          <>
            {workspace ? (
              <span className="truncate font-display text-sm font-semibold tracking-tight">
                {workspace.name}
              </span>
            ) : (
              <span className="h-3.5 w-20 animate-pulse rounded bg-surface-2" />
            )}
            <button
              type="button"
              onClick={onTogglePin}
              aria-label="Collapse sidebar"
              aria-expanded
              aria-controls={navId}
              title="Collapse sidebar · ⌘B"
              className={clsx('ml-auto flex size-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text', FOCUS_RING)}
            >
              <IconChevron size={ICON_SECONDARY} className="rotate-90" />
            </button>
          </>
        ) : (
          // The single expand affordance (§4.1: solid border everywhere —
          // this design system reserves dashed borders for placeholders,
          // and a shipped, working control wearing that convention read as
          // permanently unfinished).
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-expanded={false}
            aria-controls={navId}
            title={peeking ? undefined : 'Expand sidebar · ⌘B'}
            onClick={onTogglePin}
            onMouseEnter={() => {
              peekTimer.current = setTimeout(() => onPeek?.(), PEEK_DELAY_MS);
            }}
            onMouseLeave={() => {
              if (peekTimer.current) clearTimeout(peekTimer.current);
              onPeekEnd?.();
            }}
            // Deliberately NOT opened on focus. An earlier pass did that and
            // called it keyboard parity; it isn't. The peek renders as a DOM
            // sibling AFTER this whole column, so Tab from here goes to the
            // rail's own next icon, never into the peek — a keyboard user saw
            // the panel flash and vanish, and could never reach a link in it.
            // Making it reachable would mean pulling focus into a panel just
            // because someone tabbed past a button, which hijacks navigation.
            //
            // Keyboard users are already served, better: every rail icon is
            // wrapped in Tooltip, which opens on focus (Tooltip.tsx), so
            // tabbing the rail reveals each label in place — and ⌘B commits to
            // the full panel. Peek is a pointer affordance for previewing
            // labels without committing; the keyboard has its own answer to
            // that question and does not need this one.
            className={clsx('flex h-6 w-9 items-center justify-center rounded-lg border border-border-strong text-text-muted hover:bg-surface-2 hover:text-text', FOCUS_RING)}
          >
            <IconChevronRight size={ICON_SECONDARY} />
          </button>
        )}
      </div>

      <nav
        className={clsx('flex flex-col gap-1 pt-2', pinned ? 'px-2' : 'px-0')}
      >
        <NavRow pinned={pinned} to="/" end icon={IconHome} label="Home" />
        <NavRow
          pinned={pinned}
          to="/your-work"
          icon={IconUser}
          label="My work"
        />
        <MySessionsNavRow pinned={pinned} />
        {/* Customer feedback round 1, Fix 9: My Jira sat twelfth down the
            rail, below every project group, off-screen at 1080px. It is a
            person's own queue, like My work and My sessions, so it sits
            with them — always visible, never a scroll away. */}
        <MyJiraNavRow pinned={pinned} />
        {/* Notifications is reached from the topbar bell only (ROAD-160). */}
      </nav>

      <div className="mx-2 my-3 border-t border-border" />

      <nav className={clsx('flex flex-col gap-1', pinned ? 'px-2' : 'px-0')}>
        {/* Propose->approve is the product's organising model (product
            strategy decision 2), so Review sits in its own group separated
            by rules rather than blended into the dashboards below. No
            section caption: shell-ux-v3.md §3 — a label over a single row
            is a caption, not a group, and it read as clutter above one
            item. The separators already do the grouping work. */}
        <NavRow
          pinned={pinned}
          to="/review"
          icon={IconReview}
          label="Review"
          badge={{ count: pendingProposalCount, tone: 'alert' }}
        />
      </nav>

      <div className="mx-2 my-3 border-t border-border" />

      {pinned ? (
        <>
          <div className="flex items-center justify-between px-4">
            <span className="text-[10.5px] font-semibold tracking-wide text-text-muted uppercase">
              Projects
            </span>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              aria-label="Add project"
              className="flex size-5 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
            >
              <IconPlus size={ICON_SECONDARY} />
            </button>
          </div>
          <div className="mt-1 flex flex-col gap-1 px-2">
            <NavRow
              pinned={pinned}
              to="/projects"
              end
              icon={IconFolder}
              label="All projects"
            />
            {/* Was "Views" (opened a plain, unfiltered "All work items"
                table) — now the workspace scope of W5.2's unified
                TicketList: the same filter/group/search/bulk surface as a
                project's list, just with no project restriction
                (docs/design/waypoint-revamp-mockup.html:610). */}
            <NavRow
              pinned={pinned}
              to="/views"
              icon={IconLayers}
              label="All tickets"
            />
          </div>
          <div className="mt-1 flex flex-col gap-3 px-2">
            {projects?.map((p) => <ProjectRow key={p.id} project={p} />)}
          </div>
        </>
      ) : (
        /* The rail's two project-scope destinations. The flyout icon itself
           routes to /projects ("All projects") and lists the individual
           projects on hover; "All tickets" gets its own icon rather than
           living only in that flyout's footer, because it is a top-level
           destination in the panel and a rail item you have to discover by
           hovering something else is not the same as one you can see. */
        <div className="flex flex-col gap-1">
          <div className="flex justify-center">
            <ProjectsFlyout />
          </div>
          <NavRow
            pinned={pinned}
            to="/views"
            icon={IconLayers}
            label="All tickets"
          />
        </div>
      )}

      <div className="flex-1" />

      <nav
        className={clsx(
          'flex flex-col gap-1 py-3',
          pinned ? 'px-2' : 'px-0',
        )}
      >
        <NavRow
          pinned={pinned}
          to="/projects/archived"
          icon={IconArchive}
          label="Archive"
        />
        <NavRow
          pinned={pinned}
          to="/analytics"
          icon={IconChart}
          label="Analytics"
        />
        <NavRow
          pinned={pinned}
          to="/settings/general"
          icon={IconSettings}
          label="Workspace settings"
        />
      </nav>

      {pinned ? (
        <button
          type="button"
          onClick={() => navigate('/machine')}
          className="mx-2 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-success" />
          <span className="min-w-0 flex-1 truncate text-left">
            <b className="font-semibold text-text">Local</b> · {repoCount} repo
            {repoCount === 1 ? '' : 's'} ·{' '}
            {claudeReady ? 'Claude ready' : 'Claude not detected'}
          </span>
          <IconChevronRight size={ICON_SECONDARY} className="shrink-0 text-text-muted" />
        </button>
      ) : (
        <Tooltip label={localSummary}>
          <button
            type="button"
            aria-label={localSummary}
            onClick={() => navigate('/machine')}
            className="relative mx-auto mb-2 flex size-[30px] items-center justify-center rounded-full border border-border bg-surface text-[10px] font-bold text-text-secondary hover:border-border-strong hover:text-text"
          >
            <span aria-hidden>L</span>
            <span className="absolute -right-px -bottom-px size-2 rounded-full bg-success ring-2 ring-bg-inset" />
          </button>
        </Tooltip>
      )}

      {/* When MY_JIRA_ENABLED is off, this is byte-for-byte the same
          CreateProjectModal mount phase 1 always had — the wizard component
          (and its Companion option) isn't in the tree at all, so the "+"
          button's behavior is unchanged. */}
      {MY_JIRA_ENABLED ? (
        <AddProjectWizard
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(project) => {
            upsertProjects([project]);
            navigate(`/projects/${project.id}/tickets`);
          }}
        />
      ) : (
        <CreateProjectModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(project) => {
            upsertProjects([project]);
            navigate(`/projects/${project.id}/tickets`);
          }}
        />
      )}
    </aside>
  );
}
