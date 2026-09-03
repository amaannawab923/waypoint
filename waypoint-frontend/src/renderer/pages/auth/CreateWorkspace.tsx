import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { getWorkspace, updateWorkspace } from '@/data/api';
import { markOnboarding } from '@/lib/onboarding';

/**
 * One-time first-run step shown right after login, before the user ever
 * reaches Home. Pre-filled with the existing mock workspace's name so it
 * doesn't feel broken — Waypoint only ever has the one seeded workspace, this
 * just gives it a name the user chose.
 */
export default function CreateWorkspace() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getWorkspace().then((workspace) => {
      if (cancelled) return;
      setName(workspace.name);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const valid = name.trim().length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      await updateWorkspace({ name: name.trim() });
      markOnboarding('true');
      navigate('/');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] border border-border bg-surface p-8 shadow-2xl">
        <div className="mb-8 text-center">
          <h1 className="font-display text-xl font-semibold text-text">Name your workspace</h1>
          <p className="mt-1.5 text-sm text-text-muted">
            This is how your team will know it. You can change it later.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="workspace-name" className="text-xs font-medium text-text-secondary">
              Workspace name
            </label>
            <input
              id="workspace-name"
              autoFocus
              disabled={!loaded}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none placeholder:text-text-muted focus:border-accent disabled:opacity-50"
            />
          </div>

          <Button type="submit" variant="primary" size="md" disabled={!valid || !loaded || saving} className="w-full">
            {saving ? 'Creating…' : 'Create workspace'}
          </Button>
        </form>
      </div>
    </div>
  );
}
