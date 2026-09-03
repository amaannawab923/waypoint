import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { RepoLinkPicker } from './RepoLinkPicker';
import { UndoStrip } from './RepoLinkedCard';
import { useRepoLink, useRepoUnlink } from './useRepoLink';

interface RepoLinkStaleCardProps {
  projectId: string;
  projectName: string;
  projectIdentifier?: string;
  repoPath: string;
  /** A successful Relocate — distinct from onChanged, which also covers Unlink, so only this one triggers the "just linked" success banner. */
  onRelocated: () => void;
  onChanged: () => void;
}

/** The exact folder is known not to exist, so the dialog opens at its parent. */
function parentOf(repoPath: string): string | null {
  const parts = repoPath.split(/[\\/]/);
  parts.pop();
  const parent = parts.join('/');
  return parent || null;
}

/**
 * G6's other half: the stored path no longer resolves, so say so instead of
 * displaying a dead path as if it were healthy while Copilot quietly answers
 * without code.
 *
 * Unlink here skips the confirm step the linked card shows — there is
 * nothing left to talk the user out of for a link that is already broken —
 * but keeps the same undo window.
 *
 * The suggestions strip below is told `hideBrowse`: this card's own
 * Relocate… is already the one dialog trigger for "pick a folder to fix
 * this", so a second Browse… button offering the identical dialog used to
 * sit right underneath it, each with its own independently-styled error
 * surface depending on which one you'd clicked. Suggestion clicks still go
 * through the picker's own hook, since a one-click link is a genuinely
 * different action from opening a dialog, not a duplicate of Relocate….
 */
export function RepoLinkStaleCard({
  projectId,
  projectName,
  projectIdentifier,
  repoPath,
  onRelocated,
  onChanged,
}: RepoLinkStaleCardProps) {
  const {
    browse,
    saving,
    error: linkError,
    dismissError,
  } = useRepoLink(projectId, onRelocated);
  const unlinking = useRepoUnlink(projectId, repoPath, onChanged);

  if (unlinking.phase === 'undoable') {
    return <UndoStrip projectName={projectName} unlinking={unlinking} />;
  }

  const relocate = () =>
    browse({
      defaultPath: parentOf(repoPath) ?? undefined,
      title: `Relocate ${projectName}'s local checkout`,
      message: `Find where ${projectName}'s checkout moved to — the folder that contains .git.`,
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2.5 rounded-[var(--radius)] border border-warning/40 bg-warning-bg p-3">
        <AlertTriangle size={17} className="mt-px shrink-0 text-warning" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-[13.5px] font-semibold text-warning">
            The linked folder no longer exists
          </div>
          <div className="text-[13px] text-warning opacity-90">
            <span className="font-mono text-xs break-all">{repoPath}</span> was
            moved or deleted. Copilot is still answering questions about this
            project, but <b className="font-semibold">without code access</b> —
            answers won&apos;t be grounded in the repo until this is fixed.
          </div>
          <div className="mt-1.5 flex gap-2">
            <Button
              variant="secondary"
              size="xs"
              disabled={saving}
              onClick={relocate}
            >
              {saving ? 'Saving…' : 'Relocate…'}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={unlinking.busy}
              onClick={unlinking.unlink}
            >
              Unlink
            </Button>
          </div>
          {unlinking.error && (
            <p className="mt-1 text-[12.5px] text-danger">
              {unlinking.error.title} — {unlinking.error.body}
            </p>
          )}
          {linkError && (
            <div className="mt-1 flex flex-col gap-1.5">
              <div className="text-[12.5px] font-semibold text-danger">
                {linkError.title}
              </div>
              <div className="text-[12.5px] text-danger opacity-90">
                {linkError.body}
              </div>
              <Button
                variant="ghost"
                size="xs"
                className="self-start text-danger hover:bg-danger-bg hover:text-danger"
                onClick={dismissError}
              >
                Dismiss
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* The same suggestions strip the unlinked state offers: a checkout that
          moved is usually now sitting next to another project's known root.
          hideBrowse: Relocate… above is already this card's one dialog
          trigger — see the component doc comment. */}
      <RepoLinkPicker
        projectId={projectId}
        projectName={projectName}
        projectIdentifier={projectIdentifier}
        browseDefaultPath={parentOf(repoPath)}
        hideBrowse
        onLinked={onRelocated}
      />
    </div>
  );
}
