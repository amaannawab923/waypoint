import { useState } from 'react';
import { clsx } from 'clsx';
import { NotWired } from '@/components/ui/NotWired';

interface ToggleRow {
  key: string;
  label: string;
  description: string;
}

const ROWS: ToggleRow[] = [
  {
    key: 'email',
    label: 'Email notifications',
    description: 'Receive a daily digest of activity in your workspace by email.',
  },
  {
    key: 'push',
    label: 'Push notifications',
    description: 'Get notified in your browser when something needs your attention.',
  },
  {
    key: 'mentions',
    label: 'Notify on mentions',
    description: 'Alert me when someone @mentions me in a comment or description.',
  },
  {
    key: 'comments',
    label: 'Notify on comments',
    description: 'Alert me when someone comments on a ticket I created or am assigned to.',
  },
];

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
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
  const [values, setValues] = useState<Record<string, boolean>>({
    email: true,
    push: true,
    mentions: true,
    comments: false,
  });

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 font-display text-lg font-medium text-text">Notifications</h2>
      <p className="mb-3 text-sm text-text-secondary">Choose what you get notified about.</p>

      <div className="mb-4">
        <NotWired capability="profile.notificationPrefs" />
      </div>

      <div className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border bg-surface">
        {ROWS.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div>
              <p className="text-sm font-medium text-text">{row.label}</p>
              <p className="text-xs text-text-secondary">{row.description}</p>
            </div>
            <Switch
              checked={values[row.key]}
              label={row.label}
              onChange={() => setValues((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
