import { useEffect, useState } from 'react';
import { useAsync } from '@/lib/useAsync';
import { getCurrentUser, updateCurrentUser } from '@/mock/api';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';

const inputClass =
  'h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent';

const labelClass = 'mb-1.5 block text-sm font-medium text-text';

export default function Profile() {
  const { data: user, loading } = useAsync(() => getCurrentUser(), []);
  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setFullName(user.fullName);
      setDisplayName(user.displayName);
      setEmail(user.email);
    }
  }, [user]);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      await updateCurrentUser({ fullName, displayName, email });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="mb-6 font-display text-lg font-medium text-text">Profile</h2>

      {loading && !user && (
        <Skeleton className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <Skeleton.Circle size="56px" />
            <div>
              <Skeleton.Block height="0.875rem" width="8rem" className="mb-1.5" />
              <Skeleton.Block height="0.75rem" width="10rem" />
            </div>
          </div>
          <div>
            <Skeleton.Block height="0.875rem" width="6rem" className="mb-1.5" />
            <Skeleton.Block height="2.25rem" />
          </div>
          <div>
            <Skeleton.Block height="0.875rem" width="7rem" className="mb-1.5" />
            <Skeleton.Block height="2.25rem" />
          </div>
          <div>
            <Skeleton.Block height="0.875rem" width="4rem" className="mb-1.5" />
            <Skeleton.Block height="2.25rem" />
          </div>
        </Skeleton>
      )}

      {user && (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <Avatar name={fullName || user.fullName} color={user.avatarColor} size={56} />
            <div>
              <p className="text-sm font-medium text-text">Profile photo</p>
              <p className="text-xs text-text-muted">Generated from your initials</p>
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="full-name">
              Full name
            </label>
            <input
              id="full-name"
              className={inputClass}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="display-name">
              Display name
            </label>
            <input
              id="display-name"
              className={inputClass}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            {saved && <span className="text-sm text-success">Saved</span>}
          </div>

          <div className="mt-6 rounded-[var(--radius-lg)] border border-danger/30 bg-danger-bg p-5">
            <h3 className="mb-1 font-display text-sm font-medium text-danger">Deactivate account</h3>
            <p className="mb-4 text-sm text-text-secondary">
              Deactivating your account removes your access to every workspace and project you're a
              member of. This action cannot be undone.
            </p>
            <Button variant="danger">Deactivate account</Button>
          </div>
        </div>
      )}
    </div>
  );
}
