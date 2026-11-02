import { useRef, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';

export type TicketSectionTab = 'comments' | 'activity';

const TABS: { key: TicketSectionTab; label: string }[] = [
  { key: 'comments', label: 'Comments' },
  { key: 'activity', label: 'Activity' },
];

/**
 * The tabs over a ticket's lower section: the conversation, or the change
 * history — one at a time. Real tab semantics: roving tabindex, ←/→ and
 * Home/End between tabs, each tab labelling the one panel below.
 */
export function TicketSectionTabs({
  idPrefix,
  value,
  onChange,
  counts,
}: {
  idPrefix: string;
  value: TicketSectionTab;
  onChange: (tab: TicketSectionTab) => void;
  counts: Partial<Record<TicketSectionTab, number>>;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex((t) => t.key === value);
    const last = TABS.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % TABS.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + TABS.length) % TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    onChange(TABS[next]!.key);
    refs.current[next]?.focus();
  }

  return (
    <div role="tablist" aria-label="Ticket discussion and history" onKeyDown={onKeyDown} className="flex items-end gap-5">
      {TABS.map((t, i) => {
        const selected = t.key === value;
        const count = counts[t.key];
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
            aria-controls={`${idPrefix}-panel-${t.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={clsx(
              '-mb-px inline-flex h-9 cursor-pointer items-center gap-1.5 border-b-2 font-display text-sm font-medium transition-colors outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-accent/40',
              selected ? 'border-text text-text' : 'border-transparent text-text-muted hover:text-text-secondary',
            )}
          >
            {t.label}
            {count !== undefined && count > 0 && (
              <span
                className={clsx(
                  'rounded-full px-1.5 text-[11px] leading-[18px] font-semibold tabular-nums',
                  selected ? 'bg-surface-3 text-text' : 'bg-surface-2 text-text-muted',
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
