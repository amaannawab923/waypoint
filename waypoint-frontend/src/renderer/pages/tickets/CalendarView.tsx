import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronLeft } from 'lucide-react';
import { IconChevronRight, IconPlus } from '@/components/icons';
import { useProject } from '@/layouts/ProjectLayout';
import type { TicketsView } from './useTicketsView';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { CreateTicketModal } from '@/components/domain/CreateTicketModal';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function mondayOnOrBefore(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Month grid, Monday–Friday columns (matches Plane's real calendar view).
 * Tickets render as small chips on their due-date cell; days without a
 * due-dated item stay empty.
 */
export default function CalendarView({
  view,
  onOpenItem,
}: {
  view: TicketsView;
  onOpenItem: (identifier: string) => void;
}) {
  const { project } = useProject();
  const { items, loading, reload } = view;
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()));
  const [createOpen, setCreateOpen] = useState(false);
  const today = new Date();

  const weeks = useMemo(() => {
    const last = endOfMonth(cursor);
    const rows: Date[][] = [];
    let week = mondayOnOrBefore(cursor);
    while (week <= last) {
      rows.push(Array.from({ length: 5 }, (_, i) => addDays(week, i)));
      week = addDays(week, 7);
    }
    return rows;
  }, [cursor]);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, typeof items>();
    for (const item of items) {
      if (!item.dueDate) continue;
      const key = dateKey(new Date(item.dueDate));
      const arr = map.get(key) ?? [];
      arr.push(item);
      map.set(key, arr);
    }
    return map;
  }, [items]);

  if (loading) {
    return (
      <Skeleton className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <Skeleton.Block height="1rem" width="9rem" />
          <div className="flex items-center gap-2">
            <Skeleton.Block height="1.75rem" width="4rem" rounded="rounded-[var(--radius-sm)]" />
            <Skeleton.Circle size="1.75rem" />
            <Skeleton.Circle size="1.75rem" />
          </div>
        </div>
        <div className="grid grid-cols-5 border-b border-border">
          {WEEKDAY_LABELS.map((d) => (
            <div key={d} className="px-3 py-2">
              <Skeleton.Block height="0.65rem" width="2rem" />
            </div>
          ))}
        </div>
        <div className="grid flex-1 grid-cols-5 auto-rows-fr">
          {Array.from({ length: 30 }).map((_, i) => (
            <div key={i} className="min-h-[104px] border-r border-b border-border p-1.5 last:border-r-0">
              <Skeleton.Circle size="1.5rem" />
              {i % 3 === 0 && <Skeleton.Block height="0.75rem" width="80%" className="mt-2" />}
            </div>
          ))}
        </div>
      </Skeleton>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No tickets"
        description="Tickets with a due date will show up on the calendar."
      />
    );
  }

  const monthLabel = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-display text-sm font-semibold text-text">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setCursor(startOfMonth(new Date()))}>
            Today
          </Button>
          <IconButton label="Previous month" onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}>
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton label="Next month" onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}>
            <IconChevronRight size={16} />
          </IconButton>
        </div>
      </div>

      <div className="grid grid-cols-5 border-b border-border text-xs font-medium text-text-secondary">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="px-3 py-2">
            {d}
          </div>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-5 auto-rows-fr">
        {weeks.map((week) =>
          week.map((day) => {
            const inMonth = day.getMonth() === cursor.getMonth();
            const dayItems = itemsByDay.get(dateKey(day)) ?? [];
            return (
              <div
                key={dateKey(day)}
                className={clsx(
                  'group min-h-[104px] border-r border-b border-border p-1.5 last:border-r-0',
                  !inMonth && 'bg-bg-inset/60',
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={clsx(
                      'inline-flex size-6 items-center justify-center rounded-full text-xs',
                      isSameDay(day, today)
                        ? 'bg-accent font-semibold text-on-accent'
                        : inMonth
                          ? 'text-text'
                          : 'text-text-muted',
                    )}
                  >
                    {day.getDate()}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    aria-label="New ticket"
                    className="cursor-pointer rounded-[var(--radius-sm)] p-1 text-text-muted opacity-0 hover:bg-surface hover:text-accent group-hover:opacity-100"
                  >
                    <IconPlus size={13} />
                  </button>
                </div>
                <div className="mt-1 flex flex-col gap-1">
                  {dayItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onOpenItem(item.identifier)}
                      title={`${item.identifier} ${item.title}`}
                      className="block w-full cursor-pointer truncate rounded-[var(--radius-sm)] bg-surface-2 px-1.5 py-0.5 text-left text-[11px] text-text transition-colors hover:bg-accent-soft-bg hover:text-accent-soft-text"
                    >
                      <span className="font-mono text-text-muted">{item.identifier}</span> {item.title}
                    </button>
                  ))}
                </div>
              </div>
            );
          }),
        )}
      </div>

      <CreateTicketModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={project.id}
        onCreated={() => reload()}
      />
    </div>
  );
}
