import { useState } from 'react';
import { Ruler, Trash2 } from 'lucide-react';
import { IconEdit } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { useProject } from '@/layouts/ProjectLayout';
import { updateProjectEstimate } from '@/data/api';
import type { EstimateType } from '@/types/entities';

const ESTIMATE_PRESETS: Record<EstimateType, { label: string; description: string; values: string[] }> = {
  points: {
    label: 'Points',
    description: 'Fibonacci-style points to estimate relative effort.',
    values: ['0', '1', '2', '3', '5', '8', '13', '21'],
  },
  categories: {
    label: 'Sizes',
    description: 'T-shirt sizes for a lightweight, relative estimate.',
    values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  },
};

function EstimatePickerModal({
  open,
  onClose,
  onPicked,
}: {
  open: boolean;
  onClose: () => void;
  onPicked: (type: EstimateType) => void;
}) {
  const [selected, setSelected] = useState<EstimateType>('points');
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    if (saving) return;
    setSaving(true);
    try {
      await onPicked(selected);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add estimate system"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleConfirm} disabled={saving}>
            {saving ? 'Adding…' : 'Add estimate system'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {(Object.keys(ESTIMATE_PRESETS) as EstimateType[]).map((type) => {
          const preset = ESTIMATE_PRESETS[type];
          return (
            <button
              key={type}
              type="button"
              onClick={() => setSelected(type)}
              className={
                'flex flex-col gap-1 rounded-[var(--radius-sm)] border px-4 py-3 text-left transition-colors ' +
                (selected === type
                  ? 'border-accent bg-accent-soft-bg'
                  : 'border-border-strong hover:bg-surface-2')
              }
            >
              <span className="text-sm font-medium text-text">{preset.label}</span>
              <span className="text-xs text-text-secondary">{preset.description}</span>
              <span className="mt-1 text-xs text-text-muted">{preset.values.join(', ')}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

export default function Estimates() {
  const { project, reloadProject } = useProject();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function handlePick(type: EstimateType) {
    await updateProjectEstimate(project.id, { type, values: ESTIMATE_PRESETS[type].values });
    setPickerOpen(false);
    reloadProject();
  }

  async function handleRemove() {
    if (removing) return;
    setRemoving(true);
    try {
      await updateProjectEstimate(project.id, null);
      reloadProject();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="font-display text-lg font-medium text-text">Estimates</h1>
      </div>

      {!project.estimate ? (
        <EmptyState
          icon={<Ruler size={28} />}
          title="No estimates yet"
          description="Define how your team measures effort and track it consistently across all tickets."
          action={
            <Button variant="primary" onClick={() => setPickerOpen(true)}>
              Add estimate system
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-border-strong p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text">{ESTIMATE_PRESETS[project.estimate.type].label}</p>
              <p className="mt-1 text-sm text-text-secondary">
                {ESTIMATE_PRESETS[project.estimate.type].description}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <IconButton label="Change estimate system" onClick={() => setPickerOpen(true)}>
                <IconEdit size={14} />
              </IconButton>
              <IconButton label="Remove estimate system" onClick={handleRemove} disabled={removing}>
                <Trash2 size={14} />
              </IconButton>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {project.estimate.values.map((v) => (
              <Badge key={v} outline>
                {v}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <EstimatePickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onPicked={handlePick} />
    </div>
  );
}
