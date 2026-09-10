import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  disconnectJira,
  getJiraConnectionStatus,
  refreshJiraSync,
} from '@/data/jiraApi';
import { setJiraConnection } from '@/lib/jiraStore';
import { clearMyJiraQuery } from '@/pages/jira/useMyJiraQueue';
import { showErrorToast } from '@/lib/toast';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconAlert, IconCircleDot } from '@/components/icons';
import { JiraMark } from '@/components/domain/JiraMark';
import { AddProjectWizard } from '@/components/domain/AddProjectWizard';
import type { JiraConnectionStatus } from '@/types/jira';

/**
 * What a disconnect actually does, in the terms a confirm dialog has to be
 * honest about: `jira:disconnect` (jiraIpc.ts) deletes the stored API token
 * outright, immediately, with no undo — unlike archiving a project, there is
 * no Archive page to restore this from. A standalone function within this
 * file, the same shape `lib/projectArchiveCopy.ts` gives its own confirm
 * text (as a dedicated file there, since `archiveConfirmMessage` has a
 * second call site `ProjectCard` doesn't own), even though this one is so
 * far a single call site — "what this button actually does" is worth
 * stating once either way, so a second call site showing up later has it
 * ready rather than reinventing the wording.
 */
export function disconnectJiraConfirmMessage(accountEmail: string): string {
  return (
    `Disconnect ${accountEmail || 'this Jira account'}? Waypoint deletes the ` +
    `stored API token from this device immediately — your issues, comments ` +
    `and everything else stay exactly as they are in Jira. You can ` +
    `reconnect any time.`
  );
}

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
  onRefresh,
}: {
  connection: JiraConnectionStatus;
  /**
   * How the surrounding page re-reads its own data, when it has data of its
   * own to re-read.
   *
   * Without this, Refresh updated the shared connection store — the sync
   * clock, the issue and project counts — while the list of rows beside it
   * kept whatever it fetched on mount. Pressing Refresh therefore produced a
   * green, pulsing "synced 0s ago" over stale rows, and could put a fresh
   * "98 issues" next to 97 visible ones. A control whose whole purpose is to
   * make the screen current must not leave most of the screen behind.
   *
   * The page's own reader is used rather than a second refreshJiraSync()
   * here, so Refresh stays exactly one network read.
   */
  onRefresh?: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showConnectWizard, setShowConnectWizard] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      if (onRefresh) {
        // The page re-reads, which repopulates the shared cache and stamps
        // lastSyncAt; the status read that follows is local, so this is still
        // one round trip to Jira.
        await onRefresh();
        setJiraConnection(await getJiraConnectionStatus());
      } else {
        setJiraConnection(await refreshJiraSync());
      }
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Could not refresh from Jira.',
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDisconnect() {
    // Deletes the stored token immediately with no undo (see
    // disconnectJiraConfirmMessage's own comment) — matches this repo's
    // established confirm() guard on every other irreversible action
    // (ProjectsList's archiveConfirmMessage).
    if (
      !window.confirm(disconnectJiraConfirmMessage(connection.accountEmail))
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      await disconnectJira();
      // The tickets are dropped by disconnectJira's own clearCache; the
      // filters that select them are held separately and would otherwise
      // outlive the account they were built against.
      clearMyJiraQuery();
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
          {connection.connected ? (
            <>
              <Avatar name={connection.accountName} size={34} />
              <div className="min-w-0">
                <b className="block text-[13.5px] font-semibold text-text">
                  {connection.accountName}
                </b>
                <div className="mt-0.5 truncate text-[12.5px] text-text-muted">
                  {connection.accountEmail} · {connection.site}
                </div>
              </div>
            </>
          ) : (
            <>
              <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-jira">
                <JiraMark size={18} />
              </span>
              <div className="min-w-0">
                <b className="block text-[13.5px] font-semibold text-text">
                  Not connected
                </b>
                {/* Replaces what used to render here with nothing on either
                    side of it — accountEmail and site both collapse to '' the
                    moment jira:status stops reporting a connection, so
                    `{email} · {site}` rendered a bare " · " with no way back
                    into the app. This is that way back: the same connect flow
                    JiraConnectionCard already opens from All-Projects. */}
                <button
                  type="button"
                  onClick={() => setShowConnectWizard(true)}
                  className="mt-0.5 text-[12.5px] font-semibold text-accent hover:underline"
                >
                  Connect to Jira
                </button>
              </div>
            </>
          )}
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
              {connection.countsTruncated ? '+' : ''}
            </b>
            {/* This panel's whole job is to report what Waypoint can see of
                your Jira, so a capped read has to say it is capped rather
                than round a 900-issue queue down to a confident "500". */}
            <span className="text-[11.5px] text-text-muted">
              {connection.countsTruncated
                ? 'issues read (your queue is larger)'
                : 'issues in your queue'}
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
          {/* Not gated on connection.connected, unlike Refresh: once a
              credential is flagged invalid after a 401 (see jiraAuth.ts's
              markJiraCredentialInvalid), jira:status reports connected:false
              even though the dead token is still on disk — and Disconnect is
              the only control that removes it. Gating this the same way
              Refresh is gated would make that token permanently
              undeletable from the UI the moment it goes bad.
              disconnectJira is already a safe no-op when nothing is
              stored, so enabling this with no credential present costs
              nothing. */}
          <Button
            size="xs"
            className="text-danger"
            disabled={disconnecting}
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
              what the user chooses. Deleting a comment joins it now for the
              same reason again: deleteJiraComment is real, gated on the
              real per-project delete permission Jira reports for the
              signed-in account (see jiraApi.ts's getJiraCommentPermissions),
              never shown on a comment the account may not remove.
              jiraApi.ts's whole write surface is transitionJiraTicket,
              postJiraComment, deleteJiraComment, setJiraTicketPriority,
              setJiraTicketAssignee and uploadJiraAttachment — six, and this
              sentence names six. (downloadJiraAttachment is not among them:
              it changes nothing about the issue. Nor is a comment's Reply
              action a write of its own — it posts through the same
              postJiraComment as any other comment, just prefilled with a
              mention; Jira comments don't thread, so a "reply" is an
              ordinary top-level comment naming who it's answering, not a
              new capability. Nor is Copy link: it copies an address to the
              clipboard and sends nothing to Jira. And there is no Edit —
              this phase doesn't have it, for a comment or anything else.) */}
          <span>
            <b>Your</b> edits — moving a ticket through its workflow, posting a
            comment (a reply included), deleting a comment you have permission
            to remove, changing its priority, reassigning it, and attaching a
            file — write straight to Jira the moment you make them, as you.
            Those six are the whole set; everything else about an issue,
            including copying a comment&apos;s link, is read-only here.
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
            Copilot proposing a priority change, a reassignment, or a new issue
            against Jira — only a comment or moving a ticket through its
            workflow can be proposed there today. (All three already work
            against your own, non-Jira projects.)
          </li>
          <li>Creating issues, and Linear and Shortcut companions.</li>
        </ul>
      </div>

      {/* The same wizard JiraConnectionCard opens from All-Projects. Mounted
          only while open, not unconditionally: AddProjectWizard calls
          useNavigate() on every render regardless of its own `open` prop,
          so an always-mounted copy would require a Router ancestor for
          this whole panel even while the wizard is closed and untouched.
          Step 1 still offers "Independent project" here, same as from
          All-Projects — a real project can come out of this reconnect
          entry point, not only a Jira reconnect, so onCreated navigates to
          it the same way ProjectsList's own "Add project" button does
          rather than silently doing nothing with it. */}
      {showConnectWizard && (
        <AddProjectWizard
          open={showConnectWizard}
          onClose={() => setShowConnectWizard(false)}
          onCreated={(project) => navigate(`/projects/${project.id}/tickets`)}
        />
      )}
    </div>
  );
}
