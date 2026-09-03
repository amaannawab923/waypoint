import { useAsync } from '@/lib/useAsync';
import { listProjects, detectLocalClaudeCode } from '@/data/api';
import { IconGitBranch, IconCheck, IconXCircle } from '@/components/icons';
import { Skeleton } from '@/components/ui/Skeleton';

// The sidebar's "Local" strip (docs/design/waypoint-revamp-mockup.html:653,
// its own data-was: "local-first was a string in a settings select. It is
// the only position a cloud tracker structurally cannot copy, so it gets
// permanent chrome... and a screen behind it") needed a real destination —
// this is it. Honest about what's actually true today: repo links and the
// Claude Code CLI probe are real (Probe<T>, never a fabricated status); the
// data layer itself still runs through the local Postgres/Docker dev stack,
// not an embedded/offline store, so this page says that plainly rather than
// implying a fully offline app that doesn't exist yet.
export default function MachinePage() {
  const { data: projects, loading: projectsLoading } = useAsync(() => listProjects(), []);
  const { data: claude, loading: claudeLoading } = useAsync(() => detectLocalClaudeCode(), []);

  const linked = (projects ?? []).filter((p) => p.repoPath);
  const unlinked = (projects ?? []).filter((p) => !p.repoPath);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 md:p-8">
      <div>
        <h1 className="font-display text-2xl font-medium text-text">This machine</h1>
        <p className="mt-1 text-sm text-text-secondary">
          What runs locally, and what Copilot can currently see on this computer.
        </p>
      </div>

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
        <h2 className="mb-3 font-display text-sm font-medium text-text">Claude Code CLI</h2>
        {claudeLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : claude?.state === 'present' ? (
          <div className="flex items-center gap-2 text-sm text-text">
            <IconCheck size={16} className="text-success" />
            Detected — version {claude.value.version}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <IconXCircle size={16} className="text-text-muted" />
            Not detected on this machine{claude?.state === 'absent' && claude.reason ? ` — ${claude.reason}` : ''}
          </div>
        )}
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
        <h2 className="mb-3 font-display text-sm font-medium text-text">Linked repositories</h2>
        {projectsLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (projects ?? []).length === 0 ? (
          <p className="text-sm text-text-secondary">No projects yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {[...linked, ...unlinked].map((project) => (
              <div key={project.id} className="flex items-center gap-2.5 py-2.5 text-sm">
                <IconGitBranch size={14} className="shrink-0 text-text-muted" />
                <span className="shrink-0 font-medium text-text">{project.name}</span>
                {project.repoPath ? (
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                    {project.repoPath}
                  </span>
                ) : (
                  <span className="text-xs text-text-muted italic">not linked</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
        <h2 className="mb-2 font-display text-sm font-medium text-text">Where your data lives</h2>
        <p className="text-sm text-text-secondary">
          Waypoint's app data currently runs through a local Postgres instance on this machine, not a
          fully embedded offline store yet — there's no cloud sync, but it does depend on Docker being
          available. A fully in-process local database is a planned change, not something this build
          claims today.
        </p>
      </section>
    </div>
  );
}
