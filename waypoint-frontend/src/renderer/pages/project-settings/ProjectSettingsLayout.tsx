import { NavLink, Outlet } from 'react-router-dom';
import { clsx } from 'clsx';
import { useProject, type ProjectOutletContext } from '@/layouts/ProjectLayout';
import { useRepoLinkStatus, type RepoLinkStatus } from '@/lib/useRepoLinkStatus';

interface NavItem {
  to: string;
  label: string;
  /** Mirrors the header badge's state onto the nav item that fixes it. */
  showRepoStatus?: boolean;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { to: 'general', label: 'General' },
      { to: 'members', label: 'Members' },
      { to: 'features', label: 'Features' },
      { to: 'codebase', label: 'Codebase', showRepoStatus: true },
    ],
  },
  {
    label: 'Work Structure',
    items: [
      { to: 'states', label: 'States' },
      { to: 'labels', label: 'Labels' },
      { to: 'estimates', label: 'Estimates' },
    ],
  },
  {
    label: 'Execution',
    items: [{ to: 'automations', label: 'Automations' }],
  },
];

function repoStatusDotClass(status: RepoLinkStatus): string {
  if (status.kind === 'linked') return 'bg-success';
  if (status.kind === 'stale') return 'bg-warning';
  return 'bg-text-muted';
}

export default function ProjectSettingsLayout() {
  const ctx = useProject();
  const { project } = ctx;
  const { status: repoStatus } = useRepoLinkStatus(project.repoPath);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border px-4 py-6">
        <div className="flex items-center gap-2 px-2">
          <span className="text-lg leading-none">{project.icon}</span>
          <span className="font-display truncate text-sm font-medium text-text">{project.name}</span>
        </div>
        <nav className="flex flex-col gap-4">
          {NAV_GROUPS.map((group, i) => (
            <div key={group.label ?? i} className="flex flex-col gap-0.5">
              {group.label && (
                <div className="px-2 pb-1 text-xs font-medium tracking-wide text-text-muted uppercase">
                  {group.label}
                </div>
              )}
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center rounded-[var(--radius-sm)] px-2 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-accent-soft-bg text-accent-soft-text font-medium'
                        : 'text-text-secondary hover:bg-surface-2 hover:text-text',
                    )
                  }
                >
                  {item.label}
                  {item.showRepoStatus && (
                    <span
                      className={clsx(
                        'ml-auto size-1.5 rounded-full',
                        repoStatusDotClass(repoStatus),
                      )}
                    />
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <Outlet context={ctx satisfies ProjectOutletContext} />
      </div>
    </div>
  );
}
