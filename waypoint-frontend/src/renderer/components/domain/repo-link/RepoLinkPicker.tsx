import { AlertCircle, FolderGit2, FolderOpen } from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import {
  useRepoSuggestions,
  type RepoSuggestion,
} from '@/lib/useRepoSuggestions';
import { useRepoLink } from './useRepoLink';

interface RepoLinkPickerProps {
  projectId: string;
  projectName: string;
  projectIdentifier?: string;
  /** Seeds the dialog so "Change folder…" opens at the current link. */
  currentRepoPath?: string | null;
  /** Overrides the dialog's starting directory (Relocate… opens at the dead path's parent). */
  browseDefaultPath?: string | null;
  browseLabel?: string;
  /**
   * Suggestions only, no Browse… button or hint text — for a caller that
   * already offers its own, differently-labeled dialog trigger (RepoLinkStaleCard's
   * prominent Relocate…) and would otherwise duplicate it: two buttons opening
   * the same picker, with two independent error surfaces depending on which
   * one was clicked.
   */
  hideBrowse?: boolean;
  /** The in-chat card's tighter variant — same component, denser rows. */
  compact?: boolean;
  onLinked: (path: string) => void;
}

/**
 * The unlinked state, shared verbatim by project settings → Codebase and the
 * in-chat card: suggestions first, the OS dialog as the escape hatch rather
 * than the only door, and one inline error where the user's attention
 * already is.
 */
export function RepoLinkPicker({
  projectId,
  projectName,
  projectIdentifier = '',
  currentRepoPath = null,
  browseDefaultPath,
  browseLabel = 'Browse…',
  hideBrowse = false,
  compact = false,
  onLinked,
}: RepoLinkPickerProps) {
  const { suggestions } = useRepoSuggestions(
    projectId,
    projectName,
    projectIdentifier,
  );
  const { saving, error, checkingNonRepo, link, browse, dismissError } =
    useRepoLink(projectId, onLinked);

  const defaultPath = browseDefaultPath ?? currentRepoPath ?? undefined;
  const openDialog = () =>
    browse({
      defaultPath: defaultPath ?? undefined,
      title: `Link ${projectName} to its local checkout`,
      message: `Pick the top level of ${projectName}'s git checkout — the folder that contains .git.`,
    });

  return (
    <div className={clsx('flex flex-col', compact ? 'gap-2.5' : 'gap-5')}>
      {suggestions.length > 0 &&
        (compact ? (
          <div className="flex flex-col gap-1.5">
            {suggestions.map((s) => (
              <CompactSuggestionRow
                key={s.path}
                suggestion={s}
                disabled={saving}
                onClick={() => link(s.path)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[11.5px] font-semibold tracking-wider text-text-muted uppercase">
              Suggestions
              <span className="h-px flex-1 bg-border" />
            </div>
            {suggestions.map((s) => (
              <SuggestionRow
                key={s.path}
                suggestion={s}
                disabled={saving}
                onClick={() => link(s.path)}
              />
            ))}
          </div>
        ))}

      {!hideBrowse && (
        <div
          className={clsx(
            'flex items-center gap-2.5',
            compact && 'justify-end',
          )}
        >
          <Button
            variant={
              suggestions.length > 0 || compact ? 'secondary' : 'primary'
            }
            size={compact ? 'xs' : 'sm'}
            disabled={saving}
            onClick={openDialog}
          >
            <FolderOpen size={compact ? 12 : 14} />
            {saving ? 'Saving…' : browseLabel}
          </Button>
          {!compact && (
            <span className="text-[12.5px] text-text-muted">
              {defaultPath ? (
                <>
                  Opens at{' '}
                  <span className="font-mono text-xs">{defaultPath}</span>,
                  titled for this project.
                </>
              ) : (
                <>
                  Titled for this project, so you can tell which one you&apos;re
                  linking.
                </>
              )}
            </span>
          )}
        </div>
      )}

      {/* Fast local hint while the real request is in flight — the backend
          still decides, and this disappears either way. */}
      {checkingNonRepo && (
        <p className="text-[12.5px] text-text-muted">
          That folder doesn&apos;t look like a git repo — checking anyway…
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
          {/* The backend message stays the source of truth — it just stops
              leading. */}
          <details className="ml-[26px]">
            <summary className="cursor-pointer text-xs text-danger opacity-85">
              Technical details
            </summary>
            <pre className="mt-1.5 rounded-[var(--radius-sm)] bg-danger/10 px-2 py-1.5 font-mono text-[11.5px] break-words whitespace-pre-wrap text-danger">
              {error.raw}
            </pre>
          </details>
          <div className="ml-[26px] flex gap-2">
            {!hideBrowse && (
              <Button
                variant="secondary"
                size="xs"
                disabled={saving}
                onClick={openDialog}
              >
                Choose a different folder
              </Button>
            )}
            <Button variant="ghost" size="xs" onClick={dismissError}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function suggestionReasonLabel(suggestion: RepoSuggestion): string {
  return suggestion.reason === 'name-match'
    ? 'name matches project'
    : `linked to ${suggestion.otherProjectName}`;
}

function SuggestionRow({
  suggestion,
  disabled,
  onClick,
}: {
  suggestion: RepoSuggestion;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-[var(--radius)] border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-bg-inset disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-surface-2 text-text-secondary">
        <FolderGit2 size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[13.5px] font-medium text-text">
          {suggestion.name}
          <span
            className={clsx(
              'rounded-full border px-1.5 text-[11.5px] font-normal',
              suggestion.reason === 'name-match'
                ? 'border-info/30 bg-info-bg text-info'
                : 'border-border text-text-muted',
            )}
          >
            {suggestionReasonLabel(suggestion)}
          </span>
        </span>
        <span className="truncate font-mono text-[11.5px] text-text-secondary">
          {suggestion.path}
        </span>
      </span>
      <span className="shrink-0 text-xs text-text-muted group-hover:text-text">
        Link →
      </span>
    </button>
  );
}

function CompactSuggestionRow({
  suggestion,
  disabled,
  onClick,
}: {
  suggestion: RepoSuggestion;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 py-2 text-left transition-colors hover:border-border-strong hover:bg-bg-inset disabled:cursor-not-allowed disabled:opacity-50"
    >
      <FolderGit2 size={13} className="shrink-0 text-text-secondary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12.5px] font-medium text-text">
          {suggestion.name}
        </span>
        <span className="truncate font-mono text-[11px] text-text-muted">
          {suggestion.path}
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-text-muted">Link →</span>
    </button>
  );
}
