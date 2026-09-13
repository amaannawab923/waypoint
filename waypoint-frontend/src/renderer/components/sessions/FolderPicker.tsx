import { clsx } from 'clsx';
import { IconFolder, IconGitBranch } from '@/components/icons';
import type { SessionFolder } from '@/types/agentRuns';

/**
 * The folder list a session may start in — W4b (docs/design/
 * w4b-sessions-anywhere.md §1.1): recent folders, every project's linked
 * repository, and Browse… (the OS picker, in main). Lifted out of
 * NewSessionDialog for W5b, where the brief preview asks the same
 * question once per Jira project: which folder does ENG's code live in?
 * The list is main's (`runs:recent-folders`); a choice is a handle, never
 * a path; whoever renders this owns the state and the Browse… call.
 */
export function FolderPicker({
  labelId,
  label = 'Folder',
  folders,
  selected,
  onSelect,
  onBrowse,
  browsing,
  disabled,
  emptyHint = 'No folder yet — Browse… to pick one. A project’s linked repository shows up here on its own.',
}: {
  /** The id the radiogroup is labelled by. */
  labelId: string;
  label?: string;
  /** Null while main is still answering. */
  folders: SessionFolder[] | null;
  selected: SessionFolder | null;
  onSelect: (folder: SessionFolder) => void;
  onBrowse: () => void;
  browsing: boolean;
  disabled?: boolean;
  emptyHint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span id={labelId} className="text-xs font-medium text-text-secondary">
          {label}
        </span>
        <button
          type="button"
          onClick={onBrowse}
          disabled={disabled || browsing}
          className="text-xs font-medium text-text-secondary underline-offset-2 hover:text-text hover:underline disabled:opacity-50"
        >
          {browsing ? 'Choosing…' : 'Browse…'}
        </button>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="thin-scroll flex max-h-[176px] flex-col gap-1 overflow-y-auto rounded-[var(--radius-sm)] border border-border-strong bg-bg p-1"
      >
        {folders === null && (
          <div className="px-2 py-3 text-xs text-text-muted">
            Reading folders…
          </div>
        )}
        {folders !== null && folders.length === 0 && (
          <div className="px-2 py-3 text-xs text-text-muted">{emptyHint}</div>
        )}
        {(folders ?? []).map((folder) => {
          const isSelected = selected?.path === folder.path;
          return (
            <button
              key={folder.path}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onSelect(folder)}
              disabled={disabled}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 text-left',
                isSelected
                  ? 'bg-accent-soft-bg text-accent-soft-text'
                  : 'text-text hover:bg-surface-2',
              )}
            >
              {folder.kind === 'repo' ? (
                <IconGitBranch size={13} className="shrink-0 opacity-70" />
              ) : (
                <IconFolder size={13} className="shrink-0 opacity-70" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {folder.name}
                  {folder.projectName && (
                    <span className="ml-1.5 text-xs font-normal opacity-70">
                      · {folder.projectName}
                    </span>
                  )}
                </span>
                <span className="block truncate font-mono text-[11px] opacity-70">
                  {folder.displayPath}
                </span>
              </span>
              <span className="shrink-0 text-[10px] tracking-wide uppercase opacity-70">
                {folder.kind === 'repo' ? 'git repo' : 'folder'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
