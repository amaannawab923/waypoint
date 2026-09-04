import { useState } from 'react';
import { useProject } from '@/layouts/ProjectLayout';
import { updateProjectAutomations } from '@/data/api';
import type { ProjectAutomations } from '@/types/entities';
import { NotWired } from '@/components/ui/NotWired';
import type { CapabilityKey } from '@/capabilities';

// Defensive fallback for project records persisted before `automations`
// existed on the Project shape (db.ts backfills this on load, but this page
// stays safe even against a state store that hasn't gone through that path).
const DEFAULT_AUTOMATIONS: ProjectAutomations = {
  autoArchiveEnabled: false,
  autoArchiveAfterDays: 30,
  autoCloseEnabled: false,
  autoCloseAfterDays: 30,
};

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={
        'relative h-5 w-9 shrink-0 rounded-full transition-colors ' +
        (checked ? 'bg-accent' : 'bg-surface-2 border border-border-strong')
      }
    >
      <span
        className={
          'absolute top-0.5 size-4 rounded-full shadow transition-transform ' +
          (checked ? 'translate-x-[18px] bg-on-accent' : 'translate-x-0.5 bg-text-muted')
        }
      />
    </button>
  );
}

function AutomationRow({
  title,
  description,
  enabled,
  afterDays,
  onToggle,
  onAfterDaysChange,
  capability,
}: {
  title: string;
  description: string;
  enabled: boolean;
  afterDays: number;
  onToggle: (v: boolean) => void;
  onAfterDaysChange: (n: number) => void;
  capability: CapabilityKey;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-text">{title}</p>
          <p className="mt-0.5 text-sm text-text-secondary">{description}</p>
        </div>
        <Toggle checked={enabled} onChange={onToggle} />
      </div>
      <div className={'flex items-center gap-2 ' + (enabled ? '' : 'opacity-50')}>
        <span className="text-sm text-text-secondary">After</span>
        <input
          type="number"
          min={1}
          max={365}
          value={afterDays}
          disabled={!enabled}
          onChange={(e) => onAfterDaysChange(Math.max(1, Number(e.target.value) || 1))}
          className="h-8 w-20 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2 text-sm outline-none focus:border-accent disabled:cursor-not-allowed disabled:bg-surface-2"
        />
        <span className="text-sm text-text-secondary">days</span>
      </div>
      <NotWired capability={capability} />
    </div>
  );
}

export default function Automations() {
  const { project, reloadProject } = useProject();
  const automations = project.automations ?? DEFAULT_AUTOMATIONS;

  const [autoArchive, setAutoArchive] = useState(automations.autoArchiveEnabled);
  const [autoArchiveAfterDays, setAutoArchiveAfterDays] = useState(automations.autoArchiveAfterDays);
  const [autoClose, setAutoClose] = useState(automations.autoCloseEnabled);
  const [autoCloseAfterDays, setAutoCloseAfterDays] = useState(automations.autoCloseAfterDays);

  async function persist(patch: Partial<ProjectAutomations>) {
    await updateProjectAutomations(project.id, patch);
    reloadProject();
  }

  // Save failed (the shared HTTP client already surfaced a toast) — revert
  // the optimistic value so the control's visible state matches what's
  // actually persisted, instead of looking saved when it isn't.

  function handleAutoArchiveToggle(v: boolean) {
    const previous = autoArchive;
    setAutoArchive(v);
    persist({ autoArchiveEnabled: v }).catch(() => setAutoArchive(previous));
  }

  function handleAutoArchiveAfterDays(n: number) {
    const previous = autoArchiveAfterDays;
    setAutoArchiveAfterDays(n);
    persist({ autoArchiveAfterDays: n }).catch(() => setAutoArchiveAfterDays(previous));
  }

  function handleAutoCloseToggle(v: boolean) {
    const previous = autoClose;
    setAutoClose(v);
    persist({ autoCloseEnabled: v }).catch(() => setAutoClose(previous));
  }

  function handleAutoCloseAfterDays(n: number) {
    const previous = autoCloseAfterDays;
    setAutoCloseAfterDays(n);
    persist({ autoCloseAfterDays: n }).catch(() => setAutoCloseAfterDays(previous));
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="font-display text-lg font-medium text-text">Automations</h1>
        <p className="mt-1 text-sm text-text-secondary">Configure automatic workflow behavior for this project.</p>
      </div>

      <div className="flex flex-col divide-y divide-border rounded-[var(--radius)] border border-border">
        <AutomationRow
          title="Auto-archive closed tickets"
          description="Send a ticket to the archive once it's sat completed or cancelled for this many days."
          enabled={autoArchive}
          afterDays={autoArchiveAfterDays}
          onToggle={handleAutoArchiveToggle}
          onAfterDaysChange={handleAutoArchiveAfterDays}
          capability="automations.autoArchive"
        />
        <AutomationRow
          title="Auto-close tickets"
          description="Close a ticket that's sat untouched — never completed, never cancelled — for this many days."
          enabled={autoClose}
          afterDays={autoCloseAfterDays}
          onToggle={handleAutoCloseToggle}
          onAfterDaysChange={handleAutoCloseAfterDays}
          capability="automations.autoClose"
        />
      </div>
    </div>
  );
}
