import { useState } from 'react';
import { disconnectJira, getJiraConnectionStatus, refreshJiraSync, setJiraSyncPaused } from '@/data/jiraApi';
import { setJiraConnection } from '@/lib/jiraStore';
import { showErrorToast } from '@/lib/toast';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconAlert, IconCircleDot } from '@/components/icons';
import type { JiraConnectionStatus } from '@/types/jira';

/**
 * MyJiraPage's "Connection" tab — replaces phase 1's stub placeholder.
 * Every action here is a real (if mocked) write: Refresh now bumps
 * lastSyncAt through refreshJiraSync(), Pause sync flips a persisted
 * `paused` boolean through setJiraSyncPaused(), and Disconnect genuinely
 * calls disconnectJira() and pushes the result into jiraStore — which is
 * what makes the sidebar's MyJiraNavItem disappear live, since it reads the
 * exact same store.
 */
export function JiraConnectionPanel({ connection }: { connection: JiraConnectionStatus }) {
  const [refreshing, setRefreshing] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const updated = await refreshJiraSync();
      setJiraConnection(updated);
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : 'Could not refresh from Jira.');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleTogglePause() {
    setPausing(true);
    try {
      const updated = await setJiraSyncPaused(!connection.paused);
      setJiraConnection(updated);
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : 'Could not change sync.');
    } finally {
      setPausing(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectJira();
      const updated = await getJiraConnectionStatus();
      setJiraConnection(updated);
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : 'Could not disconnect from Jira.');
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div>
      <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface shadow-sm">
        <div className="flex items-center gap-3 border-b border-border px-4.5 py-3.5">
          <Avatar name={connection.accountName} size={34} />
          <div className="min-w-0">
            <b className="block text-[13.5px] font-semibold text-text">{connection.accountName}</b>
            <div className="mt-0.5 truncate text-[12.5px] text-text-muted">
              {connection.accountEmail} · {connection.site}
            </div>
          </div>
          {connection.connected ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-bg py-1 pr-2.5 pl-2 text-[11.5px] font-bold text-success">
              <span className="size-1.5 shrink-0 rounded-full bg-success" />
              {connection.paused ? 'Paused' : 'Live'}
            </span>
          ) : (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-2 py-1 pr-2.5 pl-2 text-[11.5px] font-bold text-text-muted">
              <span className="size-1.5 shrink-0 rounded-full bg-text-muted" />
              Disconnected
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-6 px-4.5 py-3.5">
          <div>
            <b className="block font-mono text-lg font-bold tabular-nums text-text">{connection.issueCount}</b>
            <span className="text-[11.5px] text-text-muted">issues in your queue</span>
          </div>
          <div>
            <b className="block font-mono text-lg font-bold tabular-nums text-text">{connection.projectCount}</b>
            <span className="text-[11.5px] text-text-muted">Jira projects represented</span>
          </div>
          <div>
            <b className="block font-mono text-lg font-bold tabular-nums text-text">{connection.pollIntervalSec}s</b>
            <span className="text-[11.5px] text-text-muted">poll interval</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border px-4.5 py-3">
          <Button size="xs" disabled={refreshing || !connection.connected} onClick={handleRefresh}>
            {refreshing ? 'Refreshing…' : 'Refresh now'}
          </Button>
          <Button size="xs" disabled={pausing || !connection.connected} onClick={handleTogglePause}>
            {pausing ? 'Saving…' : connection.paused ? 'Resume sync' : 'Pause sync'}
          </Button>
          <Button
            size="xs"
            className="text-danger"
            disabled={disconnecting || !connection.connected}
            onClick={handleDisconnect}
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </div>
      </div>

      <div className="mt-3.5 flex flex-col gap-2">
        <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-accent/30 bg-accent-soft-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-accent-soft-text">
          <IconCircleDot size={15} className="mt-0.5 shrink-0" />
          <span>
            <b>Your</b> edits — moving, commenting, changing priority — write straight to Jira the moment you make
            them, as you.
          </span>
        </div>
        <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-warning/30 bg-warning-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-warning">
          <IconAlert size={15} className="mt-0.5 shrink-0" />
          <span>
            <b>Copilot&apos;s</b> proposals always need an explicit approval click — no exceptions, no earned-trust
            bypass, because a Jira write reaches people who never opened Waypoint.
          </span>
        </div>
      </div>

      <div className="mt-3.5 rounded-[var(--radius)] border border-border bg-surface p-4.5 shadow-sm">
        <div className="mb-2 text-[11px] font-bold tracking-wide text-text-muted uppercase">
          Not built yet — said plainly
        </div>
        <ul className="list-disc space-y-1.5 pl-4 text-[12.5px] leading-relaxed text-text-secondary">
          <li>Uploading attachments. You can see what&apos;s attached and its size; adding one still happens in Jira.</li>
          <li>
            Rich-text authoring — tables, panels, syntax-highlighted code blocks. Comments you write here are plain
            text with @mentions.
          </li>
          <li>Linear and Shortcut companions.</li>
        </ul>
      </div>
    </div>
  );
}
