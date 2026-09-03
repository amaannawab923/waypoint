import { useState } from 'react';
import { useProject } from '@/layouts/ProjectLayout';
import { updateProjectFeatures } from '@/mock/api';
import type { ProjectFeatures } from '@/types/entities';

interface FeatureRow {
  key: keyof ProjectFeatures;
  label: string;
  description: string;
}

const FEATURE_ROWS: FeatureRow[] = [
  {
    key: 'cycles',
    label: 'Cycles',
    description:
      'Run work in fixed date ranges — each cycle has its own status, lead, and work items.',
  },
  {
    key: 'modules',
    label: 'Modules',
    description:
      'Group work items under one lead and status — for the payments migration, the redesign, anything that spans more than one cycle.',
  },
  {
    key: 'views',
    label: 'Views',
    description:
      'Save a filter, sort, and grouping of the work item list, then share it or keep it to yourself.',
  },
  {
    key: 'pages',
    label: 'Pages',
    description:
      'Write long-form docs for the project — specs, runbooks, meeting notes — nested however you like.',
  },
  {
    key: 'intake',
    label: 'Intake',
    description:
      'Give people outside the project a form to file requests that land as pending items for your team to accept or decline.',
  },
];

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ' +
        (checked ? 'bg-accent' : 'bg-surface-2 border border-border-strong')
      }
    >
      <span
        className={
          'absolute top-0.5 size-4 rounded-full bg-[var(--on-accent)] shadow transition-transform ' +
          (checked ? 'translate-x-[18px] bg-on-accent' : 'translate-x-0.5 bg-text-muted')
        }
      />
    </button>
  );
}

export default function Features() {
  const { project, reloadProject } = useProject();
  const [pending, setPending] = useState<keyof ProjectFeatures | null>(null);

  async function handleToggle(key: keyof ProjectFeatures, value: boolean) {
    setPending(key);
    try {
      await updateProjectFeatures(project.id, { [key]: value });
      reloadProject();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="font-display text-lg font-medium text-text">Features</h1>
        <p className="mt-1 text-sm text-text-secondary">Toggle features on or off for this project.</p>
      </div>

      <div className="flex flex-col divide-y divide-border rounded-[var(--radius)] border border-border">
        {FEATURE_ROWS.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-sm font-medium text-text">{row.label}</p>
              <p className="mt-0.5 text-sm text-text-secondary">{row.description}</p>
            </div>
            <Toggle
              checked={project.features[row.key]}
              onChange={(v) => handleToggle(row.key, v)}
              disabled={pending === row.key}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
