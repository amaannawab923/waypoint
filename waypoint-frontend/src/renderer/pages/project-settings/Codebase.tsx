import { useState } from 'react';
import { Check } from 'lucide-react';
import { RepoLinkPicker } from '@/components/domain/repo-link/RepoLinkPicker';
import { RepoLinkStaleCard } from '@/components/domain/repo-link/RepoLinkStaleCard';
import { RepoLinkedCard } from '@/components/domain/repo-link/RepoLinkedCard';
import { useRepoLinkStatus } from '@/lib/useRepoLinkStatus';
import { useProject } from '@/layouts/ProjectLayout';
import type { Project } from '@/types/entities';

/**
 * Links this project to a local git checkout, which is what lets Copilot
 * read real source code (read-only: Read, Glob and Grep, never Bash, Edit
 * or Write).
 *
 * Its own page rather than a field in General.tsx because the flow doesn't
 * fit General's shape: it saves the moment a folder is picked instead of
 * waiting on a shared dirty/Save state machine, and a picked folder can fail
 * backend validation — an error surface that doesn't belong mixed into
 * General's.
 *
 * A dispatcher over the three shared repo-link components rather than its own
 * implementation of any of them: the in-chat card renders the same picker and
 * the same linked card in compact form, so the two entry points are literally
 * one render tree, not two lookalikes that drift.
 */
export default function Codebase() {
  const { project, reloadProject } = useProject();
  // recheck() is deliberately not called from onLinked/onChanged below: it
  // would be bound (by useCallback) to the repoPath THIS render still has,
  // one render behind reloadProject()'s own update — a redundant check
  // against the path being replaced, racing the one useRepoLinkStatus's own
  // effect already starts once repoPath actually changes.
  const { status } = useRepoLinkStatus(project.repoPath);
  // Set only by a link that happened on this page, in this session — the
  // difference between "it's linked" (the card, always) and "you just linked
  // it" (this, once).
  const [justLinked, setJustLinked] = useState(false);

  function onLinked() {
    setJustLinked(true);
    reloadProject();
  }

  function onChanged() {
    setJustLinked(false);
    reloadProject();
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

        {justLinked && status.kind === 'linked' && (
          <div className="flex items-center gap-2 rounded-[var(--radius)] border border-success/40 bg-success-bg px-3 py-2.5 text-[13px] font-medium text-success">
            <Check size={15} strokeWidth={2.2} />
            Linked — Copilot can now read this project&apos;s code.
          </div>
        )}

        <CodebaseState
          project={project}
          stale={status.kind === 'stale'}
          onLinked={onLinked}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}

/** Unlinked, linked, or linked-but-moved — the three states, in that order. */
function CodebaseState({
  project,
  stale,
  onLinked,
  onChanged,
}: {
  project: Project;
  stale: boolean;
  onLinked: () => void;
  onChanged: () => void;
}) {
  if (!project.repoPath) {
    return (
      <RepoLinkPicker
        projectId={project.id}
        projectName={project.name}
        projectIdentifier={project.identifier}
        onLinked={onLinked}
      />
    );
  }
  if (stale) {
    return (
      <RepoLinkStaleCard
        projectId={project.id}
        projectName={project.name}
        projectIdentifier={project.identifier}
        repoPath={project.repoPath}
        onRelocated={onLinked}
        onChanged={onChanged}
      />
    );
  }
  return (
    <RepoLinkedCard
      projectId={project.id}
      projectName={project.name}
      repoPath={project.repoPath}
      onChanged={onChanged}
      showUnlink
    />
  );
}
