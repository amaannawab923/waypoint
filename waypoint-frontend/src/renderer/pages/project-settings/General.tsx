import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useProject } from '@/layouts/ProjectLayout';
import { archiveProject, deleteProject, updateProject } from '@/data/api';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export default function General() {
  const { project, reloadProject } = useProject();
  const navigate = useNavigate();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [network, setNetwork] = useState(project.network);
  const [timezone, setTimezone] = useState(project.timezone || 'UTC');
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty =
    name !== project.name ||
    description !== project.description ||
    network !== project.network ||
    timezone !== (project.timezone || 'UTC');

  async function handleSave() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await updateProject(project.id, { name: name.trim(), description, network, timezone });
      reloadProject();
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive() {
    if (archiving) return;
    setArchiving(true);
    try {
      await archiveProject(project.id);
      navigate('/projects');
    } finally {
      setArchiving(false);
    }
  }

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteProject(project.id);
      navigate('/projects');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-10 px-8 py-8">
      <div>
        <h1 className="font-display text-lg font-medium text-text">General</h1>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text">Project name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text">Project ID</label>
          <input
            value={project.identifier}
            disabled
            className="h-9 w-full cursor-not-allowed rounded-[var(--radius-sm)] border border-border bg-surface-2 px-3 font-mono text-sm text-text-muted outline-none"
          />
          <p className="text-xs text-text-muted">The project identifier cannot be changed after creation.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text">Network</label>
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
          <p className="text-xs text-text-muted">
            {network === 'public'
              ? 'Anyone in the workspace can see this project.'
              : 'Only invited members can see this project.'}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text">Project Timezone</label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <p className="text-xs text-text-muted">Dates and due times in this project are shown in this timezone.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text">Created on</span>
          <p className="text-sm text-text-secondary">{formatDate(project.createdAt)}</p>
        </div>

        <div>
          <Button variant="primary" disabled={!dirty || !name.trim() || saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-border-strong p-5">
        <div>
          <h2 className="font-display text-sm font-medium text-text">Archive project</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Archiving a project will unlist your project from your side navigation. You will still be able to
            access it from the projects page, but it will no longer show up in the sidebar or be searchable.
          </p>
        </div>
        <div>
          <Button variant="secondary" onClick={handleArchive} disabled={archiving}>
            {archiving ? 'Archiving…' : 'Archive project'}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-danger/40 p-5">
        <div>
          <h2 className="font-display text-sm font-medium text-danger">Delete project</h2>
          <p className="mt-1 text-sm text-text-secondary">
            When you delete a project, all of the data associated with that project, including work items, cycles,
            modules, and pages, will be permanently removed. This action cannot be undone.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!confirmDelete ? (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete project
            </Button>
          ) : (
            <>
              <Button variant="danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
