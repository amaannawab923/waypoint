import { formatDistanceToNowStrict } from 'date-fns';
import { AlertCircle, Check, FolderGit2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useRepoDescribe, useRepoLink, useRepoUnlink } from './useRepoLink';

interface RepoLinkedCardProps {
  projectId: string;
  projectName: string;
  repoPath: string;
  /** The in-chat variant: one dense row, no scope note, no Unlink. */
  compact?: boolean;
  showUnlink?: boolean;
  onChanged: () => void;
}

function basename(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
}

/** Absent and unparseable both mean "no chip" — never a rendered "unknown". */
export function relativeCommitTime(
  lastCommitAt: string | null | undefined,
): string | null {
  if (!lastCommitAt) return null;
  const at = new Date(lastCommitAt);
  if (Number.isNaN(at.getTime())) return null;
  return formatDistanceToNowStrict(at, { addSuffix: true });
}

/**
 * The linked state, shared verbatim by project settings → Codebase and the
 * in-chat card: what got linked, shown as a recognizable repo rather than a
 * path string the user has to read character by character.
 *
 * Every describe field degrades independently — a repo with no commits yet
 * simply has no "last commit" chip, which is accurate rather than broken.
 */
export function RepoLinkedCard({
  projectId,
  projectName,
  repoPath,
  compact = false,
  showUnlink = false,
  onChanged,
}: RepoLinkedCardProps) {
  const described = useRepoDescribe(repoPath);
  const { saving, error, browse, dismissError } = useRepoLink(
    projectId,
    onChanged,
  );
  const unlinking = useRepoUnlink(projectId, repoPath, onChanged);

  const name = described?.name ?? basename(repoPath);
  const displayPath = described?.displayPath ?? repoPath;
  const commitAgo = relativeCommitTime(described?.lastCommitAt);

  const changeFolder = () =>
    browse({
      defaultPath: repoPath,
      title: `Link ${projectName} to its local checkout`,
      message: `Pick the top level of ${projectName}'s git checkout — the folder that contains .git.`,
    });

  if (unlinking.phase === 'undoable') {
    return <UndoStrip projectName={projectName} unlinking={unlinking} />;
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2.5 rounded-[var(--radius)] border border-success/40 bg-success-bg px-3 py-2.5">
        <FolderGit2 size={15} className="shrink-0 text-success" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[12.5px] font-semibold text-success">
            {name}
          </span>
          <span className="truncate font-mono text-[11px] text-success opacity-85">
            {[
              displayPath,
              described?.branch,
              commitAgo && `updated ${commitAgo}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface">
        <div className="flex items-start gap-3 p-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-surface-2 text-text">
            <FolderGit2 size={17} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="font-display text-[14.5px] font-medium text-text">
                {name}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">
                <Check size={11} strokeWidth={2.5} />
                VERIFIED
              </span>
            </div>
            <p className="font-mono text-xs break-all text-text-secondary">
              {displayPath}
            </p>
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              {described?.branch && (
                <Chip label="branch" value={described.branch} />
              )}
              {commitAgo && <Chip label="last commit" value={commitAgo} />}
              {typeof described?.trackedFileCount === 'number' && (
                <Chip
                  label="tracked files"
                  value={described.trackedFileCount.toLocaleString()}
                />
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2 border-t border-border px-4 py-3 text-[12.5px] text-text-secondary">
          <Lock size={14} className="mt-px shrink-0 text-text-muted" />
          <span>
            Read-only:{' '}
            <span className="font-medium text-text">Read, Glob, Grep</span>.
            Never edits, writes or runs anything.
          </span>
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-bg-inset px-4 py-2.5">
          <Button
            variant="secondary"
            size="xs"
            disabled={saving}
            onClick={changeFolder}
          >
            {saving ? 'Saving…' : 'Change folder…'}
          </Button>
          <span className="flex-1" />
          {/* Deliberately lower visual weight than "Change folder…" — the
              action a user reaching for this row usually actually wants. */}
          {showUnlink && unlinking.phase === 'idle' && (
            <Button
              variant="ghost"
              size="xs"
              className="text-danger hover:bg-danger-bg hover:text-danger"
              onClick={unlinking.askToConfirm}
            >
              Unlink
            </Button>
          )}
        </div>
      </div>

      {unlinking.phase === 'confirming' && (
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-border-strong bg-bg-inset p-3">
          <div className="text-[13.5px] font-semibold text-text">
            Unlink this repository?
          </div>
          <div className="text-[13px] text-text-secondary">
            Copilot will stop reading this project&apos;s code. You can re-link
            it at any time.
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="xs"
              disabled={unlinking.busy}
              onClick={unlinking.unlink}
            >
              Unlink
            </Button>
            <Button variant="ghost" size="xs" onClick={unlinking.keepIt}>
              Keep it
            </Button>
          </div>
        </div>
      )}

      {unlinking.error && (
        <p className="text-[12.5px] text-danger">
          {unlinking.error.title} — {unlinking.error.body}
        </p>
      )}

      {error && (
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-danger/40 bg-danger-bg p-3">
          <div className="flex gap-2.5">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-danger">
                {error.title}
              </div>
              <div className="mt-0.5 text-[13px] break-words text-danger opacity-90">
                {error.body}
              </div>
            </div>
          </div>
          <div className="ml-[26px] flex gap-2">
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
  );
}

/**
 * Rendered in place of the (now gone) card rather than as a global toast —
 * consistent with keeping every message in this flow inline, where the
 * user's attention already is.
 */
export function UndoStrip({
  projectName,
  unlinking,
}: {
  projectName: string;
  unlinking: ReturnType<typeof useRepoUnlink>;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-[var(--radius)] border border-border-strong bg-bg-inset px-3 py-2.5">
      <span className="text-[13px] text-text-secondary">
        Unlinked — Copilot is no longer reading {projectName}&apos;s code.
      </span>
      <span className="flex-1" />
      <Button
        variant="secondary"
        size="xs"
        disabled={unlinking.busy}
        onClick={unlinking.undo}
      >
        Undo ({unlinking.secondsLeft}s)
      </Button>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-2 py-0.5 text-[11.5px] text-text-secondary">
      {label}
      <b className="font-mono text-[11px] font-medium text-text">{value}</b>
    </span>
  );
}
