import { useEffect, useRef, useState, type ComponentType } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAllProjects } from '@/lib/projectsStore';
import { usePendingProposalCount } from '@/lib/proposalStore';
import { useWaitingSessionsCount } from '@/lib/sessionsStore';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  IconChevronRight,
  IconFolder,
  IconHome,
  IconLayers,
  IconReview,
  IconSettings,
  IconUser,
  IconBot,
} from '@/components/icons';

/**
 * The 56 px icon rail Waypoint's sidebar folds to inside a focus workspace
 * — today only "My sessions" (W3, docs/design/w3-sessions-rail.md §1.2).
 *
 * Six destinations and nothing else: Home, My work, My sessions (with its
 * waiting badge), Review, Projects (one icon whose hover flyout lists the
 * projects) and Settings, plus the Local status dot. Notifications, Drafts,
 * Scratchpad, Archive, Analytics and My Jira are deliberately not here —
 * they are one peek or pin away through the expand affordance under the
 * logo, which AppShell owns: hovering it (≥ PEEK_DELAY_MS) overlays the
 * full sidebar without resizing the workspace, clicking it (or ⌘B) pins
 * the full sidebar open. The rail itself is only ever 56 px; it never
 * carries state of its own beyond the flyout.
 */

export const RAIL_WIDTH_PX = 56;
export const PEEK_DELAY_MS = 200;
/** More projects than this fold into "All projects & tickets". */
const FLYOUT_MAX_PROJECTS = 6;

const railItemClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'relative flex size-9 items-center justify-center rounded-lg transition-colors',
    isActive
      ? 'bg-accent-soft-bg text-accent-soft-text'
      : 'text-text-secondary hover:bg-surface-2 hover:text-text',
  );

function RailBadge({ count, alert }: { count: number; alert?: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={clsx(
        'absolute -top-0.5 -right-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] font-bold ring-2 ring-bg-inset',
        alert ? 'bg-danger text-white' : 'bg-surface-2 text-text-secondary',
      )}
    >
      {count}
    </span>
  );
}

function RailLink({
  to,
  label,
  icon: Icon,
  end,
  badge,
  alertBadge,
}: {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  end?: boolean;
  badge?: number;
  alertBadge?: boolean;
}) {
  return (
    <Tooltip label={label}>
      <NavLink to={to} end={end} className={railItemClass} aria-label={label}>
        <Icon size={17} />
        {badge !== undefined && <RailBadge count={badge} alert={alertBadge} />}
      </NavLink>
    </Tooltip>
  );
}

/** Projects fold into one icon; hovering (or focusing) it lists them. */
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
        className={railItemClass}
        aria-label="Projects"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconFolder size={17} />
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
              navigate('/views');
            }}
            className="mt-1 flex w-full items-center gap-2 rounded-[var(--radius-sm)] border-t border-border px-2 pt-2 pb-1.5 text-left text-sm text-text-secondary hover:bg-surface-2"
          >
            <IconLayers size={13} className="shrink-0 text-text-muted" />
            <span className="truncate">
              All projects &amp; tickets{hidden > 0 ? ` (+${hidden})` : ''}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export interface SidebarRailProps {
  /** Hovering the expand affordance long enough: AppShell overlays the full sidebar. */
  onPeek: () => void;
  /** The pointer left the affordance without clicking. */
  onPeekEnd: () => void;
  /** Clicking the affordance: AppShell pins the full sidebar open. */
  onPin: () => void;
  /** The Local status strip's facts, rendered as one dot with a title. */
  localSummary: string;
}

export function SidebarRail({
  onPeek,
  onPeekEnd,
  onPin,
  localSummary,
}: SidebarRailProps) {
  const waiting = useWaitingSessionsCount();
  const pendingProposals = usePendingProposalCount();
  const navigate = useNavigate();
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
      data-sidebar-rail
      className="flex h-full shrink-0 flex-col items-center gap-1 border-r border-border bg-bg-inset py-2.5"
      style={{ width: RAIL_WIDTH_PX }}
    >
      <div className="mb-1 flex size-[26px] shrink-0 items-center justify-center rounded-md bg-accent bg-[image:var(--accent-gradient)] text-on-accent shadow-sm">
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

      <Tooltip label="Expand sidebar · ⌘B">
        <button
          type="button"
          aria-label="Expand sidebar"
          onClick={onPin}
          onMouseEnter={() => {
            peekTimer.current = setTimeout(onPeek, PEEK_DELAY_MS);
          }}
          onMouseLeave={() => {
            if (peekTimer.current) clearTimeout(peekTimer.current);
            onPeekEnd();
          }}
          className="flex h-6 w-9 items-center justify-center rounded-lg border border-dashed border-border-strong text-text-muted hover:bg-surface-2 hover:text-text"
        >
          <IconChevronRight size={12} />
        </button>
      </Tooltip>

      <div className="my-1.5 h-px w-[26px] bg-border" />

      <RailLink to="/" end label="Home" icon={IconHome} />
      <RailLink to="/your-work" label="My work" icon={IconUser} />
      <RailLink
        to="/sessions"
        label={
          waiting > 0
            ? `My sessions · ${waiting} waiting on you`
            : 'My sessions'
        }
        icon={IconBot}
        badge={waiting}
        alertBadge
      />
      <RailLink
        to="/review"
        label="Review"
        icon={IconReview}
        badge={pendingProposals}
        alertBadge
      />
      <ProjectsFlyout />

      <div className="flex-1" />

      <RailLink
        to="/settings/general"
        label="Workspace settings"
        icon={IconSettings}
      />
      <div className="my-1.5 h-px w-[26px] bg-border" />
      <Tooltip label={localSummary}>
        <button
          type="button"
          aria-label={localSummary}
          onClick={() => navigate('/machine')}
          className="relative flex size-[30px] items-center justify-center rounded-full border border-border bg-surface text-[10px] font-bold text-text-secondary hover:border-border-strong hover:text-text"
        >
          <span aria-hidden>L</span>
          <span className="absolute -right-px -bottom-px size-2 rounded-full bg-success ring-2 ring-bg-inset" />
        </button>
      </Tooltip>
    </aside>
  );
}
