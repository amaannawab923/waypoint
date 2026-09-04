import { NavLink, Outlet } from 'react-router-dom';
import { clsx } from 'clsx';
import { Sliders } from 'lucide-react';
import { IconUser, IconBell, IconShield, IconKey, IconSparkles } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { getCurrentUser } from '@/data/api';
import { Avatar } from '@/components/ui/Avatar';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-sm transition-colors',
    isActive
      ? 'bg-accent-soft-bg font-medium text-accent-soft-text'
      : 'text-text-secondary hover:bg-surface-2 hover:text-text',
  );

const PROFILE_ITEMS = [
  { to: 'general', label: 'Profile', icon: IconUser },
  { to: 'preferences', label: 'Preferences', icon: Sliders },
  { to: 'notifications', label: 'Notifications', icon: IconBell },
  { to: 'security', label: 'Security', icon: IconShield },
  { to: 'copilot', label: 'Copilot', icon: IconSparkles },
];

export default function ProfileSettingsLayout() {
  const { data: user } = useAsync(() => getCurrentUser(), []);

  return (
    <div className="mx-auto flex max-w-5xl gap-10 px-6 py-8">
      <aside className="w-56 shrink-0">
        <div className="mb-5 flex items-center gap-2.5 px-2.5">
          {user && (
            <Avatar name={user.fullName} color={user.avatarColor} size={32} />
          )}
          <div className="min-w-0">
            <p className="truncate font-display text-sm font-medium text-text">
              {user?.fullName ?? 'Profile settings'}
            </p>
            {user && (
              <p className="truncate text-xs text-text-muted">{user.email}</p>
            )}
          </div>
        </div>

        <p className="mb-1.5 px-2.5 text-xs font-medium tracking-wide text-text-muted uppercase">
          Your profile
        </p>
        <nav className="mb-5 flex flex-col gap-0.5">
          {PROFILE_ITEMS.map((item) => (
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
          <NavLink to="tokens" className={navLinkClass}>
            <IconKey size={15} className="shrink-0" />
            <span className="truncate">Personal access tokens</span>
          </NavLink>
        </nav>
      </aside>

      <div className="min-w-0 flex-1 pb-16">
        <Outlet />
      </div>
    </div>
  );
}
