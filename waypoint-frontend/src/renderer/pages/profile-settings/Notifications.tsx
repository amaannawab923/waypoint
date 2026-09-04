import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { NotWired } from '@/components/ui/NotWired';
import { useAsync } from '@/lib/useAsync';
import { getCurrentUser, updateCurrentUser } from '@/data/api';
import type { NotificationPrefs } from '@/types/entities';

interface ToggleRow {
  key: keyof NotificationPrefs;
  label: string;
  description: string;
}

const ROWS: ToggleRow[] = [
  {
    key: 'email',
    label: 'Email notifications',
    description:
      'Receive a daily digest of activity in your workspace by email.',
  },
  {
    key: 'push',
    label: 'Push notifications',
    description:
      'Get notified in your browser when something needs your attention.',
  },
  {
    key: 'mentions',
    label: 'Notify on mentions',
    description:
      'Alert me when someone @mentions me in a comment or description.',
  },
  {
    key: 'comments',
    label: 'Notify on comments',
    description:
      'Alert me when someone comments on a ticket I created or am assigned to.',
  },
];

// Matches Notifications page's own defaults from before this was
// persisted — used whenever a member has never saved a preference yet
// (notificationPrefs is null, or missing a key it doesn't cover yet).
const DEFAULT_PREFS: Required<NotificationPrefs> = {
  email: true,
  push: true,
  mentions: true,
  comments: false,
};

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={clsx(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors',
        checked ? 'bg-accent' : 'bg-surface-2 border border-border-strong',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 size-4 rounded-full bg-[var(--on-accent)] shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export default function Notifications() {
  const { data: user } = useAsync(() => getCurrentUser(), []);
  const [values, setValues] =
    useState<Required<NotificationPrefs>>(DEFAULT_PREFS);

  // Was pure local state seeded from a hardcoded default with no load and
  // no save call — every toggle updated the UI instantly but silently
  // reverted on reload, even though the disclosure below claimed these
  // preferences "are saved". Load the member's real, persisted value (if
  // any) once it arrives.
  useEffect(() => {
    if (user)
      setValues({ ...DEFAULT_PREFS, ...(user.notificationPrefs ?? {}) });
  }, [user]);

  async function handleToggle(key: keyof NotificationPrefs) {
    const next = { ...values, [key]: !values[key] };
    setValues(next);
    await updateCurrentUser({ notificationPrefs: { [key]: next[key] } });
  }

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 font-display text-lg font-medium text-text">
        Notifications
      </h2>
      <p className="mb-3 text-sm text-text-secondary">
        Choose what you get notified about.
      </p>

      <div className="mb-4">
        <NotWired capability="profile.notificationPrefs" />
      </div>

      <div className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border bg-surface">
        {ROWS.map((row) => (
          <div
            key={row.key}
            className="flex items-center justify-between gap-4 px-4 py-3.5"
          >
            <div>
              <p className="text-sm font-medium text-text">{row.label}</p>
              <p className="text-xs text-text-secondary">{row.description}</p>
            </div>
            <Switch
              checked={values[row.key]}
              label={row.label}
              onChange={() => handleToggle(row.key)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
