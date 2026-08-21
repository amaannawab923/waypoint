import { useState } from 'react';
import { Laptop, Smartphone, ShieldCheck } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { getCurrentUser } from '@/mock/api';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

interface SessionInfo {
  id: string;
  device: string;
  icon: typeof Laptop;
  location: string;
  lastActive: string;
  current: boolean;
}

const SESSIONS: SessionInfo[] = [
  { id: 'sess-1', device: 'Chrome on macOS', icon: Laptop, location: 'San Francisco, US', lastActive: 'Active now', current: true },
  { id: 'sess-2', device: 'Safari on iPhone', icon: Smartphone, location: 'San Francisco, US', lastActive: '2 days ago', current: false },
];

const inputClass =
  'h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent';

const labelClass = 'mb-1.5 block text-sm font-medium text-text';

export default function Security() {
  const { data: user } = useAsync(() => getCurrentUser(), []);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saved, setSaved] = useState(false);

  const canSubmit = currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  function handleChangePassword() {
    if (!canSubmit) return;
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="max-w-lg">
      <h2 className="mb-6 font-display text-lg font-medium text-text">Security</h2>

      <div className="mb-8">
        <h3 className="mb-1 font-display text-sm font-medium text-text">Change password</h3>
        <p className="mb-4 text-sm text-text-secondary">
          {user
            ? `Signed in as ${user.email}. Choose a new password with at least 8 characters.`
            : 'Choose a new password with at least 8 characters.'}
        </p>
        <div className="flex flex-col gap-4">
          <div>
            <label className={labelClass} htmlFor="current-password">
              Current password
            </label>
            <input
              id="current-password"
              type="password"
              className={inputClass}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="new-password">
              New password
            </label>
            <input
              id="new-password"
              type="password"
              className={inputClass}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="confirm-password">
              Confirm new password
            </label>
            <input
              id="confirm-password"
              type="password"
              className={inputClass}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={!canSubmit} onClick={handleChangePassword}>
              Change password
            </Button>
            {saved && <span className="text-sm text-success">Password updated</span>}
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-1 font-display text-sm font-medium text-text">Active sessions</h3>
        <p className="mb-4 text-sm text-text-secondary">
          Devices currently signed in to your account.
        </p>
        <div className="flex flex-col gap-2">
          {SESSIONS.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-border bg-surface p-3.5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-surface-2 text-text-secondary">
                  <s.icon size={16} />
                </span>
                <div>
                  <p className="text-sm text-text">{s.device}</p>
                  <p className="text-xs text-text-muted">
                    {s.location} · {s.lastActive}
                  </p>
                </div>
              </div>
              {s.current ? (
                <Badge tone="success">
                  <ShieldCheck size={11} />
                  This device
                </Badge>
              ) : (
                <Button variant="ghost" size="sm">
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
