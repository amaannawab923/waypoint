import { useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useProject } from '@/layouts/ProjectLayout';
import { useTicketsView } from './useTicketsView';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';

type Zoom = 'week' | 'month' | 'quarter';

const ZOOM_DAY_WIDTH: Record<Zoom, number> = { week: 56, month: 24, quarter: 10 };
const ZOOM_LABEL: Record<Zoom, string> = { week: 'Week', month: 'Month', quarter: 'Quarter' };
const DURATION_WIDTH = 64;
const LEFT_WIDTH = 260;
const ROW_HEIGHT = 40;
const MIN_RANGE_DAYS = 60;

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function diffDays(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);
}

function durationLabel(start: Date | null, end: Date | null): string {
  if (!start || !end) return '—';
  const days = diffDays(start, end) + 1;
  return `${days}d`;
}

const MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });

/**
 * Week/Month/Quarter zoom toggle plus a "Today" button. Left column lists
 * every ticket's identifier and title; the right side renders a
 * horizontal timeline with a colored bar spanning each item's start → due
 * date. Items with neither date have no bar and only appear in the list.
 */
export default function GanttView({ onOpenItem }: { onOpenItem: (identifier: string) => void }) {
  const { project } = useProject();
  const { items, loading, stateFor } = useTicketsView(project.id);
  const [zoom, setZoom] = useState<Zoom>('month');
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = startOfDay(new Date());

  const { rangeStart, totalDays } = useMemo(() => {
    const dates: Date[] = [today];
    for (const item of items) {
      if (item.startDate) dates.push(startOfDay(new Date(item.startDate)));
      if (item.dueDate) dates.push(startOfDay(new Date(item.dueDate)));
    }
    let min = dates.reduce((a, b) => (b < a ? b : a));
    let max = dates.reduce((a, b) => (b > a ? b : a));
    min = addDays(min, -7);
    max = addDays(max, 21);
    if (diffDays(min, max) < MIN_RANGE_DAYS) {
      max = addDays(min, MIN_RANGE_DAYS);
    }
    return { rangeStart: min, totalDays: diffDays(min, max) + 1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const dayWidth = ZOOM_DAY_WIDTH[zoom];

  const monthBands = useMemo(() => {
    const bands: { label: string; days: number }[] = [];
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(rangeStart, i);
      const label = MONTH_FORMAT.format(d);
      const last = bands[bands.length - 1];
      if (last && last.label === label) {
        last.days += 1;
      } else {
        bands.push({ label, days: 1 });
      }
    }
    return bands;
  }, [rangeStart, totalDays]);

  function scrollToToday() {
    const el = scrollRef.current;
    if (!el) return;
    const offset = LEFT_WIDTH + diffDays(rangeStart, today) * dayWidth;
    el.scrollTo({ left: Math.max(0, offset - el.clientWidth / 2), behavior: 'smooth' });
  }

  if (loading) {
    return (
      <Skeleton className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <Skeleton.Block height="1.75rem" width="9rem" rounded="rounded-[var(--radius-sm)]" />
            <Skeleton.Block height="0.75rem" width="3rem" />
          </div>
          <Skeleton.Block height="1.75rem" width="3.5rem" rounded="rounded-[var(--radius-sm)]" />
        </div>
        <div className="flex-1 overflow-hidden px-4 py-4">
          <div className="flex flex-col gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4" style={{ height: ROW_HEIGHT - 16 }}>
                <Skeleton.Block height="0.8rem" width={i % 2 === 0 ? '12rem' : '9rem'} className="shrink-0" />
                <Skeleton.Block
                  height="1.375rem"
                  width={`${25 + ((i * 13) % 45)}%`}
                  rounded="rounded-[var(--radius-sm)]"
                  className="max-w-[240px]"
                />
              </div>
            ))}
          </div>
        </div>
      </Skeleton>
    );
  }

  if (items.length === 0) {
    return <EmptyState title="No tickets" description="Tickets will show up here on the timeline." />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-[var(--radius-sm)] bg-surface-2 p-0.5">
            {(['week', 'month', 'quarter'] as Zoom[]).map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => setZoom(z)}
                className={clsx(
                  'cursor-pointer rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-medium transition-colors',
                  zoom === z ? 'bg-surface text-text shadow-sm' : 'text-text-secondary hover:text-text',
                )}
              >
                {ZOOM_LABEL[z]}
              </button>
            ))}
          </div>
          <span className="text-xs text-text-muted">
            {items.length} item{items.length === 1 ? '' : 's'}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={scrollToToday}>
          Today
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div style={{ width: LEFT_WIDTH + totalDays * dayWidth }}>
          {/* Header: month band + day row */}
          <div className="sticky top-0 z-20 bg-surface">
            <div className="flex border-b border-border">
              <div className="sticky left-0 z-30 shrink-0 border-r border-border bg-surface" style={{ width: LEFT_WIDTH }} />
              {monthBands.map((band, i) => (
                <div
                  key={`${band.label}-${i}`}
                  className="shrink-0 truncate border-r border-border px-2 py-1.5 text-xs font-medium text-text-secondary"
                  style={{ width: band.days * dayWidth }}
                >
                  {band.label}
                </div>
              ))}
            </div>
            <div className="flex border-b border-border">
              <div
                className="sticky left-0 z-30 flex shrink-0 items-center border-r border-border bg-surface"
                style={{ width: LEFT_WIDTH }}
              >
                <span className="flex-1 truncate px-3 text-[10px] font-medium tracking-wide text-text-muted uppercase">
                  Ticket
                </span>
                <span
                  className="shrink-0 border-l border-border px-2 text-[10px] font-medium tracking-wide text-text-muted uppercase"
                  style={{ width: DURATION_WIDTH }}
                >
                  Duration
                </span>
              </div>
              {Array.from({ length: totalDays }, (_, i) => {
                const d = addDays(rangeStart, i);
                const isToday = diffDays(d, today) === 0;
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <div
                    key={i}
                    className={clsx(
                      'flex shrink-0 items-center justify-center border-r border-border/60 py-1 text-[10px]',
                      isWeekend && 'bg-bg-inset/60',
                      isToday && 'bg-accent-soft-bg font-semibold text-accent-soft-text',
                    )}
                    style={{ width: dayWidth }}
                  >
                    {dayWidth >= 18 ? d.getDate() : ''}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Rows */}
          {items.map((item) => {
            const state = stateFor(item);
            const hasRange = !!(item.startDate || item.dueDate);
            const isPartialRange = !!(item.startDate && !item.dueDate) || !!(item.dueDate && !item.startDate);
            const start = item.startDate ? startOfDay(new Date(item.startDate)) : item.dueDate ? startOfDay(new Date(item.dueDate)) : null;
            const end = item.dueDate ? startOfDay(new Date(item.dueDate)) : item.startDate ? startOfDay(new Date(item.startDate)) : null;
            const barLeft = start ? diffDays(rangeStart, start) * dayWidth : 0;
            const minBarWidth = isPartialRange ? dayWidth * 3.5 : dayWidth;
            const barWidth = start && end ? Math.max(minBarWidth, (diffDays(start, end) + 1) * dayWidth - 4) : 0;

            return (
              <div key={item.id} className="flex border-b border-border" style={{ height: ROW_HEIGHT }}>
                <div
                  className="sticky left-0 z-10 flex shrink-0 border-r border-border bg-surface"
                  style={{ width: LEFT_WIDTH }}
                >
                  <button
                    type="button"
                    onClick={() => onOpenItem(item.identifier)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 truncate px-3 text-left text-xs hover:bg-surface-2"
                    title={`${item.identifier} ${item.title}`}
                  >
                    <span className="shrink-0 font-mono text-text-muted">{item.identifier}</span>
                    <span className="truncate text-text">{item.title}</span>
                  </button>
                  <span
                    className="flex shrink-0 items-center justify-center border-l border-border text-[11px] text-text-muted"
                    style={{ width: DURATION_WIDTH }}
                  >
                    {durationLabel(start, end)}
                  </span>
                </div>
                <div className="relative shrink-0" style={{ width: totalDays * dayWidth }}>
                  {hasRange && start && end && (
                    <button
                      type="button"
                      onClick={() => onOpenItem(item.identifier)}
                      title={
                        isPartialRange
                          ? `${item.identifier}: ${item.title} (only ${item.startDate ? 'start' : 'due'} date set)`
                          : `${item.identifier}: ${item.title}`
                      }
                      className={clsx(
                        'absolute top-1/2 flex -translate-y-1/2 cursor-pointer items-center overflow-hidden rounded-[var(--radius-sm)] px-2 text-[11px] font-medium text-on-accent shadow-sm transition-[filter] hover:brightness-110',
                        isPartialRange && 'border border-dashed border-on-accent/40',
                      )}
                      style={{
                        left: barLeft + 2,
                        width: barWidth,
                        height: 22,
                        backgroundColor: state?.color ?? 'var(--accent)',
                        backgroundImage: isPartialRange
                          ? 'repeating-linear-gradient(135deg, rgba(255,255,255,0.22) 0px, rgba(255,255,255,0.22) 4px, transparent 4px, transparent 8px)'
                          : undefined,
                      }}
                    >
                      <span className="truncate">{item.title}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
