import { useNavigate } from 'react-router-dom';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import { JiraMark } from '@/components/domain/JiraMark';
import { LiveSyncIndicator } from '@/pages/jira/MyJiraPage';
import { IconSettings } from '@/components/icons';
import { IconButton } from '@/components/ui/Button';

/**
 * All-Projects' own entry point into the single, app-wide Jira connection.
 *
 * Deliberately styled identically to ProjectCard below — same tile shape,
 * same header/gradient, same icon+name+badge row, same settings-button
 * position, same footer stat line — and mounted as a real cell inside the
 * same grid, not a separate strip above it. The only thing that marks this
 * as not a Waypoint-owned project is the "Companion project" badge where a
 * real project's Private/Public badge sits; everything else about the tile
 * reads the same on purpose, so it's found the same way a project is found.
 *
 * Driven by the same store `MyJiraPage` and the sidebar's nav item already
 * read (`useLoadedJiraConnection`) — whichever of the three mounts first
 * fetches the status once, and the rest just read it back live. There is no
 * third, separate "loading" rendering here: `connection?.connected` is
 * false both before the first read lands and after a real read says "not
 * connected", and the not-connected tile below already renders exactly what
 * a genuinely disconnected app should show, so a spinner state would only
 * flash in a distinction nobody can act on differently.
 *
 * Never renders the stored API token, or anything derived from it — the
 * only Jira-shaped identifiers here are `accountName`, `site`, and the two
 * counts `JiraConnectionPanel` already treats as safe to show.
 */
export function JiraConnectionCard({
  onConnectClick,
}: {
  /** What "Add Project" already does on this page — this tile's
   * not-connected state is a second entry point into that same wizard, not
   * a second flow. */
  onConnectClick: () => void;
}) {
  const connection = useLoadedJiraConnection();
  const navigate = useNavigate();
  const connected = connection?.connected ?? false;
  const openSettings = () => navigate('/my-jira?tab=connection');
  // The card's own copy ("Your own Jira work, mirrored live and writable
  // from here") and its header comment's whole point — mirroring ProjectCard
  // closely enough to be "found the same way a project is found" — both
  // require the primary click to open CONTENT, the same way ProjectCard's
  // own onClick opens /projects/:id/tickets rather than /projects/:id/settings.
  // This used to route to the connection/settings tab instead, identically
  // to the separate settings gear beside it — contradicting both. 'work' is
  // MyJiraPage's default tab, so no query param is needed to land there.
  const openWork = () => navigate('/my-jira');

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={connected ? openWork : onConnectClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (connected ? openWork : onConnectClick)();
      }}
      className={
        'flex cursor-pointer flex-col overflow-hidden rounded-[var(--radius)] border bg-surface transition-colors ' +
        (connected
          ? 'border-border hover:border-border-strong'
          : 'border-dashed border-border-strong hover:bg-surface-2')
      }
    >
      {/* Jira's own brand blue, standing in for a project's coverGradient —
          real projects get a per-project gradient because there are many of
          them to tell apart at a glance; there is only ever one Jira
          connection, so one fixed color is the correct amount of variation,
          not a missing feature. */}
      <div
        className="h-14 w-full"
        style={{ background: 'linear-gradient(135deg, #2684FF, #0052CC)' }}
      />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-[18px] shrink-0 items-center justify-center text-jira">
              <JiraMark size={18} />
            </span>
            <div className="min-w-0">
              <p className="truncate font-display text-sm font-medium text-text">
                {connection?.connected ? connection.accountName : 'Connect Jira'}
              </p>
              <p className="text-xs text-text-muted">
                {connection?.connected && (
                  <>
                    <span className="font-mono">{connection.site}</span> ·{' '}
                  </>
                )}
                <span>Companion project</span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              label="Jira connection settings"
              onClick={(e) => {
                e.stopPropagation();
                openSettings();
              }}
            >
              <IconSettings size={14} />
            </IconButton>
          </div>
        </div>

        <p className="line-clamp-2 text-xs text-text-secondary">
          {connected
            ? 'Your own Jira work, mirrored live and writable from here.'
            : 'Connect a Jira account to see your work alongside these projects.'}
        </p>

        <div className="mt-auto flex items-center justify-between border-t border-border pt-2">
          <span className="text-xs text-text-muted">
            {connection?.connected ? (
              <>
                <span className="font-mono font-semibold text-text">
                  {connection.issueCount}
                  {connection.countsTruncated ? '+' : ''}
                </span>{' '}
                issue{connection.issueCount === 1 ? '' : 's'}
              </>
            ) : (
              'Not connected'
            )}
          </span>
          {connection?.connected && (
            <LiveSyncIndicator lastSyncAt={connection.lastSyncAt} />
          )}
        </div>
      </div>
    </div>
  );
}
