import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
import { CalendarRange, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { deleteCycle, updateCycle } from '@/data/api';
import type { Cycle, WorkItem, WorkItemState } from '@/types/entities';
import { Button } from '@/components/ui/Button';
import { computeProgress, findOverlappingCycle, formatDateRange } from './cycle-utils';

/** Small self-contained popover: caller renders the trigger and the panel content. Mirrors the
 * pattern used in WorkItemDetailPage — there's no shared Dropdown/Menu primitive in
 * src/components/ui/ yet, so this stays local. */
function Dropdown({
  trigger,
  children,
  align = 'right',
}: {
  trigger: (toggle: () => void, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div className={clsx('absolute z-30 mt-1', align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * Cycle dates are persisted as full ISO timestamps (see src/mock/seed.ts), but
 * `<input type="date">` only accepts/displays `yyyy-MM-dd`. Truncate before handing the
 * stored value to a date input so the edit form shows the cycle's actual dates instead of
 * rendering empty.
 */
function toDateInputValue(value: string): string {
  return value ? value.slice(0, 10) : '';
}

function MenuItem({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2',
        danger && 'text-danger hover:bg-danger-bg',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** Compact row card for a single cycle, used in the Upcoming and Completed sections. */
export function CycleListCard({
  projectId,
  cycle,
  items,
  states,
  allCycles,
  onChanged,
}: {
  projectId: string;
  cycle: Cycle;
  items: WorkItem[];
  states: WorkItemState[];
  /** Every cycle in the project, used to block overlapping date edits. */
  allCycles: Cycle[];
  /** Called after an edit or delete so the caller can reload its cycle list. */
  onChanged: () => void;
}) {
  const progress = computeProgress(items, states);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cycle.name);
  const [startDate, setStartDate] = useState(cycle.startDate);
  const [endDate, setEndDate] = useState(cycle.endDate);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setName(cycle.name);
    setStartDate(toDateInputValue(cycle.startDate));
    setEndDate(toDateInputValue(cycle.endDate));
    setEditing(true);
  }

  const dateOrderValid = Boolean(startDate && endDate && startDate <= endDate);
  const overlapping = dateOrderValid ? findOverlappingCycle(allCycles, startDate, endDate, cycle.id) : null;
  const editValid = name.trim().length > 0 && dateOrderValid && !overlapping;

  async function handleSave() {
    if (!editValid || saving) return;
    setSaving(true);
    try {
      await updateCycle(cycle.id, { name: name.trim(), startDate, endDate });
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  function handleDelete() {
    if (!window.confirm(`Delete "${cycle.name}"? This can't be undone.`)) return;
    deleteCycle(cycle.id).then(onChanged);
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-border-strong bg-surface p-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">Cycle name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="flex gap-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Start date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">End date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </div>
        </div>
        {startDate > endDate && <p className="text-xs text-danger">End date must be on or after the start date.</p>}
        {overlapping && (
          <p className="text-xs text-danger">
            These dates overlap with “{overlapping.name}” ({formatDateRange(overlapping.startDate, overlapping.endDate)}). Pick a
            different date range.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!editValid || saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2 rounded-[var(--radius)] border border-border bg-surface px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface-2">
      <Link to={`/projects/${projectId}/cycles/${cycle.id}`} className="flex min-w-0 flex-1 items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm font-medium text-text">{cycle.name}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-text-muted">
            <CalendarRange size={12} />
            {formatDateRange(cycle.startDate, cycle.endDate)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${progress.percent}%` }} />
          </div>
          <span className="w-9 shrink-0 text-right font-mono text-xs text-text-secondary">{progress.percent}%</span>
        </div>
      </Link>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Dropdown
          trigger={(toggle) => (
            <button
              type="button"
              aria-label="Cycle actions"
              onClick={toggle}
              className="inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors hover:bg-surface hover:text-text"
            >
              <MoreHorizontal size={16} />
            </button>
          )}
        >
          {(close) => (
            <div className="w-40 rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg">
              <MenuItem
                icon={<Pencil size={14} />}
                label="Edit"
                onClick={() => {
                  close();
                  startEdit();
                }}
              />
              <div className="my-1 h-px bg-border" />
              <MenuItem
                icon={<Trash2 size={14} />}
                label="Delete"
                danger
                onClick={() => {
                  close();
                  handleDelete();
                }}
              />
            </div>
          )}
        </Dropdown>
      </div>
    </div>
  );
}
