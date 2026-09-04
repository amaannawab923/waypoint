import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import { clsx } from 'clsx';
import { Building2, Users, CreditCard, Download, Webhook } from 'lucide-react';
import { IconBot } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { getWorkspace } from '@/data/api';
import type { Workspace } from '@/types/entities';

export interface WorkspaceOutletContext {
  workspace: Workspace | undefined;
  workspaceLoading: boolean;
  reloadWorkspace: () => void;
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-sm transition-colors',
    isActive
      ? 'bg-accent-soft-bg font-medium text-accent-soft-text'
      : 'text-text-secondary hover:bg-surface-2 hover:text-text',
  );

const ADMINISTRATION_ITEMS = [
  { to: 'general', label: 'General', icon: Building2 },
  { to: 'members', label: 'Members', icon: Users },
  { to: 'agents', label: 'Agents', icon: IconBot },
  { to: 'billing', label: 'Billing', icon: CreditCard },
  { to: 'exports', label: 'Exports', icon: Download },
];

export default function WorkspaceSettingsLayout() {
  const {
    data: workspace,
    loading: workspaceLoading,
    reload: reloadWorkspace,
  } = useAsync(() => getWorkspace(), []);

  return (
    <div className="mx-auto flex max-w-5xl gap-10 px-6 py-8">
      <aside className="w-56 shrink-0">
        <div className="mb-5 px-2.5">
          <p className="text-xs text-text-muted">Workspace</p>
          <h1 className="truncate font-display text-base font-medium text-text">
            {workspace?.name ?? 'Settings'}
          </h1>
        </div>

        <p className="mb-1.5 px-2.5 text-xs font-medium tracking-wide text-text-muted uppercase">
          Administration
        </p>
        <nav className="mb-5 flex flex-col gap-0.5">
          {ADMINISTRATION_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} className={navLinkClass}>
              <item.icon size={15} className="shrink-0" />
              <span className="truncate">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <p className="mb-1.5 px-2.5 text-xs font-medium tracking-wide text-text-muted uppercase">
          Developer
        </p>
        <nav className="flex flex-col gap-0.5">
          <NavLink to="webhooks" className={navLinkClass}>
            <Webhook size={15} className="shrink-0" />
            <span className="truncate">Webhooks</span>
          </NavLink>
        </nav>
      </aside>

      <div className="min-w-0 flex-1 pb-16">
        <Outlet
          context={{ workspace, workspaceLoading, reloadWorkspace } satisfies WorkspaceOutletContext}
        />
      </div>
    </div>
  );
}

/** Use from any page nested under <WorkspaceSettingsLayout> in router.tsx to get the current workspace. */
export function useWorkspaceSettings(): WorkspaceOutletContext {
  return useOutletContext<WorkspaceOutletContext>();
}
