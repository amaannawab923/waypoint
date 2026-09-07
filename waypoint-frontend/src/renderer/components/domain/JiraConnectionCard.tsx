import { useNavigate } from 'react-router-dom';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import { JiraMark } from '@/components/domain/JiraMark';
import { LiveSyncIndicator } from '@/pages/jira/MyJiraPage';
import { IconChevronRight } from '@/components/icons';

/**
 * All-Projects' own entry point into the single, app-wide Jira connection —
 * not a project, and deliberately shaped so it never reads as one. Every
 * `ProjectCard` beside it is a grid tile with a cover gradient; this is a
 * full-width horizontal strip, so a glance at the page's own layout is
 * enough to tell the two apart before either one is read.
 *
 * Driven by the same store `MyJiraPage` and the sidebar's nav item already
 * read (`useLoadedJiraConnection`) — whichever of the three mounts first
 * fetches the status once, and the rest just read it back live. There is no
 * third, separate "loading" rendering here: `connection?.connected` is
 * false both before the first read lands and after a real read says
 * "not connected", and the not-connected slot below already renders exactly
 * what a genuinely disconnected app should show, so a spinner state would
 * only flash in a distinction nobody can act on differently.
 *
 * Never renders the stored API token, or anything derived from it — the
 * only Jira-shaped identifiers here are `accountName`, `site` and the two
 * counts `JiraConnectionPanel` already treats as safe to show.
 */
export function JiraConnectionCard({
  onConnectClick,
}: {
  /** What "Add Project" already does on this page — this card's
   * not-connected state is a second entry point into that same wizard, not
   * a second flow. */
  onConnectClick: () => void;
}) {
  const connection = useLoadedJiraConnection();
  const navigate = useNavigate();

  if (connection?.connected) {
    return (
      <button
        type="button"
        onClick={() => navigate('/my-jira?tab=connection')}
        className="mb-5 flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-left shadow-sm transition-colors hover:border-border-strong"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-jira-bg text-jira">
          <JiraMark size={18} />
        </span>
        <span className="min-w-0">
          <b className="block truncate text-[13.5px] font-semibold text-text">
            {connection.accountName}
          </b>
          <span className="block truncate text-xs text-text-muted">
            {connection.site}
          </span>
        </span>
        <LiveSyncIndicator lastSyncAt={connection.lastSyncAt} />
        <span className="ml-2 shrink-0 font-mono text-[13px] font-bold tabular-nums text-text">
          {connection.issueCount}
          {connection.countsTruncated ? '+' : ''}
        </span>
        <span className="shrink-0 text-xs text-text-muted">issues</span>
        <IconChevronRight size={16} className="ml-1 shrink-0 text-text-muted" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onConnectClick}
      className="mb-5 flex w-full items-center gap-3 rounded-[var(--radius)] border border-dashed border-border-strong bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-jira-bg text-jira">
        <JiraMark size={18} />
      </span>
      <span className="min-w-0">
        <b className="block text-[13.5px] font-semibold text-text">
          Connect Jira
        </b>
        <span className="block text-xs text-text-muted">
          See your Jira work alongside these projects
        </span>
      </span>
      <IconChevronRight
        size={16}
        className="ml-auto shrink-0 text-text-muted"
      />
    </button>
  );
}
