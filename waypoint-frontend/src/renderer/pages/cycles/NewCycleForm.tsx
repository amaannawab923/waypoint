import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { createCycle } from '@/mock/api';
import type { Cycle } from '@/types/entities';
import { findOverlappingCycle, formatDateRange } from './cycle-utils';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function inTwoWeeks(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

/** Small inline form (not a modal) for creating a cycle: name plus a start/end date range. */
export function NewCycleForm({
  projectId,
  existingCycles,
  onCancel,
  onCreated,
}: {
  projectId: string;
  existingCycles: Cycle[];
  onCancel: () => void;
  onCreated: (cycle: Cycle) => void;
}) {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(inTwoWeeks());
  const [submitting, setSubmitting] = useState(false);

  const dateOrderValid = Boolean(startDate && endDate && startDate <= endDate);
  const overlapping = dateOrderValid ? findOverlappingCycle(existingCycles, startDate, endDate) : null;
  const valid = name.trim().length > 0 && dateOrderValid && !overlapping;

  async function handleSubmit() {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const cycle = await createCycle(projectId, { name: name.trim(), description: '', startDate, endDate });
      onCreated(cycle);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-border-strong bg-surface p-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-text-secondary">Cycle name</label>
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
          {submitting ? 'Creating…' : 'Create cycle'}
        </Button>
      </div>
    </div>
  );
}
