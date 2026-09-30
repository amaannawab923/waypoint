import { useRef, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import type { NotificationTab } from '@/types/entities';

export const NOTIFICATION_TAB_LABELS: {
  key: NotificationTab;
  label: string;
}[] = [
  { key: 'all', label: 'All' },
  { key: 'mentions', label: 'Mentions' },
  // 'sessions' joins when session notifications are produced; a tab that can
  // never fill is a promise the build doesn't keep.
];

/**
 * A real tab pattern: roving tabindex, ←/→ (and Home/End) between tabs,
 * each tab controlling the one list panel below it.
 */
export function NotificationTabs({
  idPrefix,
  value,
  onChange,
  className,
}: {
  idPrefix: string;
  value: NotificationTab;
  onChange: (tab: NotificationTab) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = NOTIFICATION_TAB_LABELS.findIndex((t) => t.key === value);
    const last = NOTIFICATION_TAB_LABELS.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? i === last
          ? 0
          : i + 1
        : e.key === 'ArrowLeft'
          ? i === 0
            ? last
            : i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    onChange(NOTIFICATION_TAB_LABELS[next]!.key);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Notification filters"
      onKeyDown={onKeyDown}
      className={clsx('flex gap-1 border-b border-border', className)}
    >
      {NOTIFICATION_TAB_LABELS.map((t, i) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={clsx(
              '-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              selected
                ? 'border-accent text-text'
                : 'border-transparent text-text-secondary hover:text-text',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
