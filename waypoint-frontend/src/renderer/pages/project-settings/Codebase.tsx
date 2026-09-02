import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useProject } from '@/layouts/ProjectLayout';
import { updateProject } from '@/mock/api';

/**
 * Links this project to a local git checkout, which is what lets Copilot
 * read real source code (read-only: Read, Glob and Grep, never Bash, Edit
 * or Write).
 *
 * Its own page rather than a field in General.tsx because the flow doesn't
 * fit General's shape: the action is a native folder dialog, it saves the
 * moment a folder is picked instead of waiting on a shared dirty/Save
 * state machine, and a picked folder can fail backend validation (not a
 * git repo, deleted since it was linked) — an error surface that doesn't
 * belong mixed into General's.
 */
export default function Codebase() {
  const { project, reloadProject } = useProject();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleChoose() {
    if (saving) return;
    const picked = await window.electron.repo.chooseFolder();
    if (picked.canceled) return;
    setSaving(true);
    setError(null);
    try {
      // No local "is this a repo?" check first — the backend owns that rule
      // (projects.service.ts's validateRepoPath) so there's exactly one
      // implementation of it, and its message is what renders below.
      await updateProject(project.id, { repoPath: picked.path });
      reloadProject();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleUnlink() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateProject(project.id, { repoPath: null });
      reloadProject();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-10 px-8 py-8">
      <div>
        <h1 className="font-display text-lg font-medium text-text">Codebase</h1>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text">
            Linked repository
          </span>
          <p className="text-sm text-text-secondary">
            Link this project to its local git checkout so Copilot can read the
            code behind your tickets. Copilot gets read-only access — it can
            open, list and search files, and can never edit, write, or run
            anything.
          </p>
        </div>

        {project.repoPath ? (
          <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-border-strong p-5">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text">
                Repository path
              </span>
              <p className="font-mono text-sm break-all text-text-secondary">
                {project.repoPath}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={handleChoose}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Change folder…'}
              </Button>
              <Button variant="ghost" onClick={handleUnlink} disabled={saving}>
                Unlink
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="primary" onClick={handleChoose} disabled={saving}>
              {saving ? 'Saving…' : 'Choose folder…'}
            </Button>
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}
