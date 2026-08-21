import { Link, NavLink, Outlet } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  Image as ImageIcon,
  Mail,
  ShieldCheck,
  Sparkles,
  Settings as SettingsIcon,
} from 'lucide-react';
import { clsx } from 'clsx';

const NAV_ITEMS = [
  { key: 'general', label: 'General', to: '/admin/general', icon: SettingsIcon },
  { key: 'email', label: 'Email', to: '/admin/email', icon: Mail },
  { key: 'authentication', label: 'Authentication', to: '/admin/authentication', icon: ShieldCheck },
  { key: 'workspaces', label: 'Workspaces', to: '/admin/workspaces', icon: Building2 },
  { key: 'ai', label: 'AI', to: '/admin/ai', icon: Sparkles },
  { key: 'images', label: 'Images', to: '/admin/images', icon: ImageIcon },
] as const;

export default function AdminLayout() {
  return (
    <div className="mx-auto flex max-w-6xl gap-8 px-8 py-8">
      <aside className="w-52 shrink-0">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text"
        >
          <ArrowLeft size={14} />
          Back to Waypoint
        </Link>
        <p className="mb-3 px-1 font-display text-xs font-medium tracking-wide text-text-muted uppercase">
          Instance admin
        </p>
        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.key}
                to={item.to}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-accent-soft-bg text-accent-soft-text'
                      : 'text-text-secondary hover:bg-surface-2 hover:text-text',
                  )
                }
              >
                <Icon size={16} />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1 pb-16">
        <Outlet />
      </div>
    </div>
  );
}
