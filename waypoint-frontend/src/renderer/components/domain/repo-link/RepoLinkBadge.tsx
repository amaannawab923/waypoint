import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, FolderGit2 } from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { useRepoLinkStatus } from '@/lib/useRepoLinkStatus';
import type { Project } from '@/types/entities';
import { relativeCommitTime } from './RepoLinkedCard';
import { useRepoDescribe, useRepoLink } from './useRepoLink';

/**
 * The proactive surface the feature had none of: one quiet fact about the
 * project, in the same register as its icon or its lead, answering "is this
 * answer grounded?" before anyone asks Copilot anything — and one click from
 * the fix when it isn't.
 *
 * `checking` renders as `unlinked` rather than as its own third visual: a
 * badge that flickered through a distinct loading state on every project
 * navigation would be noisier than the fact it is reporting, and the
 * unlinked affordance is the honest thing to show while we don't yet know.
 */
export function RepoLinkBadge({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const { status } = useRepoLinkStatus(project.repoPath);
  const goToSettings = () =>
    navigate(`/projects/${project.id}/settings/codebase`);

  if (status.kind === 'stale') {
    return (
      <button
        type="button"
        onClick={goToSettings}
        className="inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-warning/40 bg-warning-bg px-2 text-xs text-warning"
      >
        <span className="size-1.5 rounded-full bg-warning" />
        Repo folder missing
      </button>
    );
  }

  if (status.kind !== 'linked' || !project.repoPath) {
    return (
      <button
        type="button"
        onClick={goToSettings}
        className="inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-dashed border-border px-2 text-xs text-text-muted transition-colors hover:text-text-secondary"
      >
        <span className="size-1.5 rounded-full bg-text-muted" />
        Code not linked
      </button>
    );
  }

  return (
    <LinkedRepoBadgePopover
      project={project}
      repoPath={project.repoPath}
      onChanged={onChanged}
      onOpenSettings={goToSettings}
    />
  );
}

function LinkedRepoBadgePopover({
  project,
  repoPath,
  onChanged,
  onOpenSettings,
}: {
  project: Project;
  repoPath: string;
  onChanged: () => void;
  onOpenSettings: () => void;
}) {
  // Lazily described: the badge itself only needs the linked/stale answer,
  // never the git detail, until someone actually opens the popover — so a
  // header rendered on every project route costs no git subprocess at all
  // unless a user asks for the detail.
  const [open, setOpen] = useState(false);
  const described = useRepoDescribe(repoPath, open);
  const { saving, error, browse, dismissError } = useRepoLink(
    project.id,
    onChanged,
  );
  const commitAgo = relativeCommitTime(described?.lastCommitAt);
  const name =
    described?.name ??
    repoPath.split(/[\\/]/).filter(Boolean).pop() ??
    repoPath;

  const changeFolder = () =>
    browse({
      defaultPath: repoPath,
      title: `Link ${project.name} to its local checkout`,
      message: `Pick the top level of ${project.name}'s git checkout — the folder that contains .git.`,
    });

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={onOpenSettings}
        className="inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-surface px-2 text-xs text-text transition-colors hover:border-border-strong hover:bg-surface-2"
      >
        <span className="size-1.5 rounded-full bg-success" />
        <FolderGit2 size={12} className="text-text-secondary" />
        {name}
      </button>

      <div
        className={clsx(
          'absolute top-[calc(100%+7px)] right-0 z-10 w-[290px] rounded-[var(--radius)] border border-border-strong bg-surface p-3 text-left shadow-lg transition-opacity',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-hidden={!open}
      >
        <div className="text-[12.5px] font-semibold text-text">
          Linked repository
        </div>
        <div className="mt-0.5 font-mono text-[11.5px] break-all text-text-secondary">
          {described?.displayPath ?? repoPath}
        </div>
        {(described?.branch || commitAgo) && (
          <div className="mt-2 flex gap-3 text-[11.5px] text-text-muted">
            {described?.branch && <span>{described.branch}</span>}
            {commitAgo && <span>updated {commitAgo}</span>}
          </div>
        )}
        <div className="mt-2 flex gap-1.5 border-t border-border pt-2">
          <Button
            variant="secondary"
            size="xs"
            disabled={saving}
            onClick={changeFolder}
          >
            {saving ? 'Saving…' : 'Change folder…'}
          </Button>
          <Button variant="ghost" size="xs" onClick={onOpenSettings}>
            Open in settings
          </Button>
        </div>

        {error && (
          <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
            <div className="flex gap-1.5">
              <AlertCircle size={13} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0">
                <div className="text-[11.5px] font-semibold text-danger">
                  {error.title}
                </div>
                <div className="mt-0.5 text-[11px] break-words text-danger opacity-90">
                  {error.body}
                </div>
              </div>
            </div>
            <div className="ml-[19px] flex gap-1.5">
              <Button
                variant="secondary"
                size="xs"
                disabled={saving}
                onClick={changeFolder}
              >
                Choose a different folder
              </Button>
              <Button variant="ghost" size="xs" onClick={dismissError}>
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
