import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { createProject } from '@/data/api';
import type { Project } from '@/types/entities';

function slugify(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
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
  // Two steps only — the form step and a confirmation. There used to be a
  // middle feature-toggle step here; sparse projects (docs/design/waypoint-
  // revamp-architecture.md §3.4) removed it entirely: a new project simply
  // starts with zero sprints/workstreams/views/docs/requests, and the
  // sidebar shows nothing for it until something real is created.
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Project['visibility']>('public');
  const [submitting, setSubmitting] = useState(false);
  const [createdProject, setCreatedProject] = useState<Project | null>(null);

  function reset() {
    setStep(1);
    setName('');
    setIdentifier('');
    setDescription('');
    setVisibility('public');
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
        visibility,
      });
      setCreatedProject(project);
      setStep(2);
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
    if (project) navigate(`/projects/${project.id}/tickets`);
  }

  const title = step === 1 ? 'New project' : 'Project created';

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
            <Button variant="primary" disabled={!name.trim() || submitting} onClick={handleCreate}>
              {submitting ? 'Creating…' : 'Create project'}
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
                onClick={() => setVisibility(n)}
                className={
                  'h-8 flex-1 rounded-[var(--radius-sm)] border text-sm capitalize transition-colors ' +
                  (visibility === n
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

      {step === 2 && createdProject && (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-base text-text">
            🎉 Congrats! <em className="font-medium not-italic text-accent">{createdProject.name}</em> created.
          </p>
        </div>
      )}
    </Modal>
  );
}
