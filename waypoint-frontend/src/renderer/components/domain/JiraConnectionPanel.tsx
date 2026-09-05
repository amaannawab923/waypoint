import { useState } from 'react';
import {
  disconnectJira,
  getJiraConnectionStatus,
  refreshJiraSync,
} from '@/data/jiraApi';
import { setJiraConnection } from '@/lib/jiraStore';
import { showErrorToast } from '@/lib/toast';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconAlert, IconCircleDot } from '@/components/icons';
import type { JiraConnectionStatus } from '@/types/jira';

/**
 * MyJiraPage's "Connection" tab. Both actions here reach the real site:
 * "Refresh now" re-runs the JQL search against Jira, and "Disconnect" deletes
 * the stored API token outright in the main process before pushing the
 * re-read status into jiraStore — which is what makes the sidebar's
 * MyJiraNavItem disappear live, since it reads the exact same store.
 *
 * A third control, "Pause sync", used to sit between them, alongside a
 * "poll interval" stat. Neither survived the move from fixtures to a real
 * site: nothing has ever polled, so the interval was a number this app did
 * not honor and the pause button paused nothing. Reads happen on mount and
 * when Refresh is pressed.
 */
export function JiraConnectionPanel({
  connection,
}: {
  connection: JiraConnectionStatus;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const updated = await refreshJiraSync();
      setJiraConnection(updated);
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Could not refresh from Jira.',
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectJira();
      const updated = await getJiraConnectionStatus();
      setJiraConnection(updated);
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Could not disconnect from Jira.',
      );
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
            <b className="block text-[13.5px] font-semibold text-text">
              {connection.accountName}
            </b>
            <div className="mt-0.5 truncate text-[12.5px] text-text-muted">
              {connection.accountEmail} · {connection.site}
            </div>
          </div>
          {connection.connected ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-bg py-1 pr-2.5 pl-2 text-[11.5px] font-bold text-success">
              <span className="size-1.5 shrink-0 rounded-full bg-success" />
              Connected
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
            <b className="block font-mono text-lg font-bold tabular-nums text-text">
              {connection.issueCount}
            </b>
            <span className="text-[11.5px] text-text-muted">
              issues in your queue
            </span>
          </div>
          <div>
            <b className="block font-mono text-lg font-bold tabular-nums text-text">
              {connection.projectCount}
            </b>
            <span className="text-[11.5px] text-text-muted">
              Jira projects represented
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border px-4.5 py-3">
          <Button
            size="xs"
            disabled={refreshing || !connection.connected}
            onClick={handleRefresh}
          >
            {refreshing ? 'Refreshing…' : 'Refresh now'}
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
          {/* This list is the capability register for Jira writes, and it is
              maintained in the same commit as the write it names — never as a
              follow-up. It once read "moving, commenting, changing priority"
              while only the first two existed, which is the failure this
              panel exists to not have (see commit e9e1ec9). Reassigning joins
              it now because setJiraTicketAssignee is real: the drawer's
              assignee chip opens a picker of the people this issue's own
              project allows, Unassign included, and writes the choice
              straight through. Attaching joins it now for the same reason:
              uploadJiraAttachment is real, and the drawer's Attachments
              header has a button that opens a native file picker and sends
              what the user chooses. jiraApi.ts's whole write surface is
              transitionJiraTicket, postJiraComment, setJiraTicketPriority,
              setJiraTicketAssignee and uploadJiraAttachment — five, and this
              sentence names five. (downloadJiraAttachment is not among them:
              it changes nothing about the issue.) */}
          <span>
            <b>Your</b> edits — moving a ticket through its workflow, posting a
            comment, changing its priority, reassigning it, and attaching a file
            — write straight to Jira the moment you make them, as you. Those
            five are the whole set; everything else about an issue is read-only
            here.
          </span>
        </div>
        <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-warning/30 bg-warning-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-warning">
          <IconAlert size={15} className="mt-0.5 shrink-0" />
          <span>
            <b>Copilot&apos;s</b> proposals always need an explicit approval
            click — no exceptions, no earned-trust bypass, because a Jira write
            reaches people who never opened Waypoint.
          </span>
        </div>
      </div>

      <div className="mt-3.5 rounded-[var(--radius)] border border-border bg-surface p-4.5 shadow-sm">
        <div className="mb-2 text-[11px] font-bold tracking-wide text-text-muted uppercase">
          Not built yet — said plainly
        </div>
        <ul className="list-disc space-y-1.5 pl-4 text-[12.5px] leading-relaxed text-text-secondary">
          {/* "Uploading attachments" used to head this list. It is gone
              because it stopped being true in the same commit that made it
              untrue — a list of things that don't work is only worth
              anything if it is maintained with the same care as the list of
              things that do. Downloading and attaching both work now; what
              remains genuinely missing is deleting an attachment and
              uploading more than one at a time, neither of which is claimed
              anywhere. Same story for comments: bold, italic, strikethrough,
              inline code, a code block, headings, lists, quotes, links and
              emoji all work now, so this list only names what still
              doesn't. */}
          <li>
            Tables and panels in a comment, and reading a Jira
            description&apos;s own formatting — that still flattens to plain
            text either way.
          </li>
          <li>
            A real inline image in a comment, the way dragging a screenshot into
            Jira&apos;s own editor embeds it. That goes through Atlassian&apos;s
            separate Media API, a different upload path from the one issue
            attachments use — attaching an image here still attaches it to the
            issue and links to it from the comment, it just doesn&apos;t preview
            inline the way a native Jira comment does.
          </li>
          <li>
            Background sync. The list is read when you open My Jira and when you
            press Refresh — nothing polls in between.
          </li>
          <li>
            Copilot proposals against Jira. The approval rail exists, but
            nothing generates a proposal from your checkout yet.
          </li>
          <li>Creating issues, and Linear and Shortcut companions.</li>
        </ul>
      </div>
    </div>
  );
}
