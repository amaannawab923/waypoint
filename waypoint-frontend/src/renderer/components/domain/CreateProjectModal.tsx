import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { createProject, updateProjectFeatures } from '@/mock/api';
import type { Project, ProjectFeatures } from '@/types/entities';

function slugify(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

const DEFAULT_FEATURES: ProjectFeatures = {
  cycles: false,
  modules: false,
  views: false,
  pages: true,
  intake: false,
};

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
      'Run work in fixed date ranges, each with its own status, lead, and work items. They don’t have to match — a two-week cycle, then a one-week one.',
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
      'Write long-form docs for the project — specs, runbooks, meeting notes — nested and organized however you like.',
  },
  {
    key: 'intake',
    label: 'Intake',
    description:
      'Give people outside the project a form to file requests. They land as pending items for your team to accept or decline.',
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
          'absolute top-0.5 size-4 rounded-full shadow transition-transform ' +
          (checked ? 'translate-x-[18px] bg-on-accent' : 'translate-x-0.5 bg-text-muted')
        }
      />
    </button>
  );
}

export function CreateProjectModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [description, setDescription] = useState('');
  const [network, setNetwork] = useState<Project['network']>('public');
  const [features, setFeatures] = useState<ProjectFeatures>(DEFAULT_FEATURES);
  const [submitting, setSubmitting] = useState(false);
  const [createdProject, setCreatedProject] = useState<Project | null>(null);

  function reset() {
    setStep(1);
    setName('');
    setIdentifier('');
    setDescription('');
    setNetwork('public');
    setFeatures(DEFAULT_FEATURES);
    setCreatedProject(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleCreate() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const project = await createProject({
        name: name.trim(),
        identifier: identifier.trim() || slugify(name),
        description: description.trim(),
        network,
      });
      const updated = await updateProjectFeatures(project.id, features);
      setCreatedProject(updated);
      setStep(3);
    } finally {
      setSubmitting(false);
    }
  }

  function handleCloseConfirmation() {
    const project = createdProject;
    reset();
    onClose();
    if (project) onCreated(project);
  }

  function handleOpenProject() {
    const project = createdProject;
    reset();
    onClose();
    if (project) navigate(`/projects/${project.id}/work-items`);
  }

  const title =
    step === 1 ? 'New project' : step === 2 ? 'Projects and work items' : 'Project created';

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!name.trim()} onClick={() => setStep(2)}>
              Continue
            </Button>
          </>
        ) : step === 2 ? (
          <>
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim() || submitting}
              onClick={handleCreate}
            >
              {submitting ? 'Creating…' : 'Continue'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={handleCloseConfirmation}>
              Close
            </Button>
            <Button variant="primary" onClick={handleOpenProject}>
              Open project
            </Button>
          </>
        )
      }
    >
      {step === 1 && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              autoFocus
              placeholder="Project name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!identifier) setIdentifier(slugify(e.target.value));
              }}
              className="h-9 flex-1 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            />
            <input
              placeholder="ID"
              value={identifier}
              onChange={(e) => setIdentifier(slugify(e.target.value))}
              maxLength={8}
              className="h-9 w-24 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-center text-sm outline-none focus:border-accent"
            />
          </div>
          <textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            {(['public', 'private'] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setNetwork(n)}
                className={
                  'h-8 flex-1 rounded-[var(--radius-sm)] border text-sm capitalize transition-colors ' +
                  (network === n
                    ? 'border-accent bg-accent-soft-bg text-accent-soft-text'
                    : 'border-border-strong text-text-secondary hover:bg-surface-2')
                }
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col divide-y divide-border rounded-[var(--radius)] border border-border">
          {FEATURE_ROWS.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-text">{row.label}</p>
                <p className="mt-0.5 text-sm text-text-secondary">{row.description}</p>
              </div>
              <Toggle
                checked={features[row.key]}
                onChange={(v) => setFeatures((f) => ({ ...f, [row.key]: v }))}
              />
            </div>
          ))}
        </div>
      )}

      {step === 3 && createdProject && (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-base text-text">
            🎉 Congrats! <em className="font-medium not-italic text-accent">{createdProject.name}</em> created.
          </p>
        </div>
      )}
    </Modal>
  );
}
