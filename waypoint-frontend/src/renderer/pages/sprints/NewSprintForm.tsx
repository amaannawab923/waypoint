import { useRef, useState } from 'react';
import { addDays, format } from 'date-fns';
import { Button } from '@/components/ui/Button';
import { createSprint } from '@/data/api';
import type { Sprint } from '@/types/entities';
import { findOverlappingSprint, formatDateRange } from './sprint-utils';

// `Date#toISOString()` renders in UTC, so a user west of UTC creating a sprint in the
// evening got tomorrow's date pre-filled here. `date-fns#format` reads the local calendar
// date instead (same fix as DatePicker.tsx's `toIsoDate` and sprint-utils.ts's
// `parseSprintDate` — the identical UTC-vs-local hazard, just on the write side this time).
function today(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

function inTwoWeeks(): string {
  return format(addDays(new Date(), 14), 'yyyy-MM-dd');
}

/** Small inline form (not a modal) for creating a sprint: name plus a start/end date range. */
export function NewSprintForm({
  projectId,
  existingSprints,
  onCancel,
  onCreated,
}: {
  projectId: string;
  existingSprints: Sprint[];
  onCancel: () => void;
  onCreated: (sprint: Sprint) => void;
}) {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(inTwoWeeks());
  const [submitting, setSubmitting] = useState(false);
  // Same fix as CopilotProposalCard.tsx's act(): "Create sprint" disables
  // itself (submitting) while the POST is in flight, and the caller
  // typically unmounts this form on success (onCreated) — either path
  // force-blurs to <body> and leaks the next keystroke to
  // useGlobalKeyboardShortcuts.ts's global nav shortcuts. This form's own
  // root is the stable container neither path touches.
  const formRef = useRef<HTMLDivElement>(null);

  const dateOrderValid = Boolean(startDate && endDate && startDate <= endDate);
  const overlapping = dateOrderValid ? findOverlappingSprint(existingSprints, startDate, endDate) : null;
  const valid = name.trim().length > 0 && dateOrderValid && !overlapping;

  async function handleSubmit() {
    if (!valid || submitting) return;
    formRef.current?.focus();
    setSubmitting(true);
    try {
      const sprint = await createSprint(projectId, { name: name.trim(), description: '', startDate, endDate });
      onCreated(sprint);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={formRef}
      tabIndex={-1}
      data-shortcut-guard
      className="flex flex-col gap-3 rounded-[var(--radius)] border border-border-strong bg-surface p-4 outline-none"
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-text-secondary">Sprint name</label>
        <input
          autoFocus
          placeholder="e.g. Sprint 12"
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
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!valid || submitting} onClick={handleSubmit}>
          {submitting ? 'Creating…' : 'Create sprint'}
        </Button>
      </div>
    </div>
  );
}
