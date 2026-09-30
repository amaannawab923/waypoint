import { useRef, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import type { NotificationTab } from '@/types/entities';

export const NOTIFICATION_TAB_LABELS: { key: NotificationTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mentions', label: 'Mentions' },
  { key: 'assigned', label: 'Assigned' },
  // 'sessions' joins when session notifications are produced; a tab that can
  // never fill is a promise the build doesn't keep.
];

/**
 * A segmented control with real tab semantics: roving tabindex, ←/→ (and
 * Home/End) between tabs, each tab controlling the one list panel below.
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
      className={clsx('inline-flex items-center gap-0.5 rounded-[10px] bg-surface-2 p-0.5', className)}
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
              'h-7 cursor-pointer rounded-[8px] px-3 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              selected
                ? 'bg-surface text-text shadow-[0_1px_2px_rgb(0_0_0/0.08)]'
                : 'text-text-secondary hover:text-text',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** "Unread only", as a compact switch. */
export function UnreadSwitch({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-[12.5px] text-text-secondary select-none">
      Unread only
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-[18px] w-[30px] shrink-0 cursor-pointer rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          checked ? 'bg-accent' : 'bg-border-strong',
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            'absolute top-[2px] left-0 size-[14px] rounded-full bg-surface shadow-sm transition-transform',
            checked ? 'translate-x-[14px]' : 'translate-x-[2px]',
          )}
        />
      </button>
    </label>
  );
}
