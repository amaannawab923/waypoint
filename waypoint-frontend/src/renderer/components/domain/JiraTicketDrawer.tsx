import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  downloadJiraAttachment,
  listJiraComments,
  setJiraTicketAssignee,
  uploadJiraAttachment,
} from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { useAsync } from '@/lib/useAsync';
import { useJiraConnection } from '@/lib/jiraStore';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconX } from '@/components/icons';
import {
  JiraAssigneeChip,
  JiraAssigneePicker,
} from '@/components/domain/JiraAssigneePicker';
import { JiraCommentComposer } from '@/components/domain/JiraCommentComposer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import { jiraProjectColor } from '@/types/jira';
import type { JiraAttachment, JiraComment, JiraTicket } from '@/types/jira';

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 45) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return 'a while ago';
}

/**
 * Right-side "peek" panel for one Jira ticket — structurally the same
 * portal/backdrop/ESC-to-close convention as components/domain/TicketDrawer.tsx
 * (docked right, slides in), not a byte-for-byte port: this one is
 * self-contained (it takes the ticket object it already has, rather than a
 * projectId/identifier pair to refetch by).
 */
export function JiraTicketDrawer({
  ticket,
  onTicketUpdated,
  onClose,
}: {
  ticket: JiraTicket;
  /**
   * Hands a re-read ticket back up to whoever owns the list behind this
   * drawer. Without it a reassign made here would update nothing but the
   * drawer's own header, and closing it would reveal a row still naming the
   * previous assignee — a stale row the user has no reason to distrust.
   */
  onTicketUpdated: (updated: JiraTicket) => void;
  onClose: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [comments, setComments] = useState<JiraComment[]>([]);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [savingAssignee, setSavingAssignee] = useState(false);
  // Which attachment is mid-download, by id — not a plain boolean, because a
  // ticket can have several rows and only the one that was clicked should say
  // "Saving…".
  const [downloading, setDownloading] = useState<string | null>(null);
  // One at a time, so a boolean is enough — unlike `downloading`, there is
  // only ever the single "Attach a file" control.
  const [uploading, setUploading] = useState(false);
  const assigneeChipRef = useRef<HTMLButtonElement>(null);
  const connection = useJiraConnection();

  /**
   * `accountId` is `null` for Unassign — the user's choice, carried as a real
   * value rather than an absence all the way to Jira's own
   * `{ accountId: null }` payload.
   *
   * The re-read ticket goes up through `onTicketUpdated` and nothing here
   * removes anything. Reassigning away from yourself can genuinely drop the
   * issue out of the "my work" query, and the row still stays until the next
   * refresh — see setJiraTicketAssignee in data/jiraApi.ts for why that is the
   * behaviour and how patching rather than filtering is what produces it.
   */
  async function handleSelectAssignee(accountId: string | null) {
    setAssigneeOpen(false);
    setSavingAssignee(true);
    try {
      onTicketUpdated(await setJiraTicketAssignee(ticket.id, accountId));
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not reassign this ticket in Jira.',
      );
    } finally {
      setSavingAssignee(false);
    }
  }

  /**
   * Hands one attachment off to main, which fetches it, asks the user where to
   * put it, writes it and reveals it in the OS file manager.
   *
   * Nothing here names a location, and nothing comes back naming one — see
   * downloadJiraAttachment in data/jiraApi.ts. The in-flight window covers the
   * dialog as well as the transfer, which is why it can be open for a while:
   * "Saving…" is true from the moment the fetch starts until the user has
   * either saved or cancelled.
   *
   * A cancel is not an error and produces no toast. There is no success toast
   * either — this app's toast system has no success channel — which is exactly
   * why main reveals the saved file in Finder/Explorer instead.
   */
  async function handleDownload(attachment: JiraAttachment) {
    if (!attachment.id) return;
    setDownloading(attachment.id);
    try {
      await downloadJiraAttachment(
        ticket.id,
        attachment.id,
        attachment.fileName,
      );
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not download that attachment from Jira.',
      );
    } finally {
      setDownloading(null);
    }
  }

  /**
   * Asks main to let the user pick a file and attach it to this issue.
   *
   * Nothing is passed but the issue id: main opens the picker, reads the file
   * and uploads it. This component cannot name a file, and could not be made
   * to by anything upstream of it.
   *
   * The re-read ticket goes up through `onTicketUpdated`, which is what
   * re-renders the list of attachments above — this drawer takes its ticket as
   * a prop from MyJiraPage, so the new attachment appears by the ordinary
   * route rather than through a second local copy of the list.
   */
  async function handleUpload() {
    setUploading(true);
    try {
      const { ticket: updated } = await uploadJiraAttachment(ticket.id);
      // Null on a cancel, which is not an error and is not an update.
      if (updated) onTicketUpdated(updated);
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not attach that file in Jira.',
      );
    } finally {
      setUploading(false);
    }
  }

  // `error` is destructured, not ignored: "No comments yet." is a positive
  // factual claim about this issue, and rendering it because the comment read
  // failed tells the user the thread is empty when the truth is that Waypoint
  // never saw it.
  const {
    data: fetchedComments,
    error: commentsError,
    reload: reloadComments,
  } = useAsync(() => listJiraComments(ticket.id), [ticket.id]);
  useEffect(() => {
    if (fetchedComments) setComments(fetchedComments);
  }, [fetchedComments]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const projectColor = jiraProjectColor(ticket.projectKey);
  // Now that a real site is connected, the canonical Jira URL for an issue is
  // just its key under that site — so the header's "Open in Jira" stops being
  // a disabled "not wired up yet" and becomes a real link. main.ts's window
  // open handler is what turns target="_blank" into the user's own browser
  // (https only, opened externally), so this never navigates the app window.
  const jiraUrl = connection?.site
    ? `https://${connection.site}/browse/${ticket.key}`
    : null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        className="thin-scroll absolute inset-y-0 right-0 flex h-full w-full max-w-[460px] flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-200 ease-out"
        style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span
            className="font-mono text-xs font-bold"
            style={{ color: projectColor }}
          >
            {ticket.key}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold text-text">
            <span
              className="size-[7px] shrink-0 rounded-full"
              style={{ background: ticket.stateColor }}
            />
            {ticket.stateName}
          </span>
          {jiraUrl ? (
            <a
              href={jiraUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto shrink-0 rounded px-2 py-1 text-xs font-semibold text-text-secondary hover:bg-surface-2 hover:text-text"
            >
              Open in Jira ↗
            </a>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              disabled
              title="No Jira site is connected."
            >
              Open in Jira ↗
            </Button>
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="thin-scroll flex-1 overflow-y-auto px-4 py-4">
          <h3 className="mb-2.5 font-display text-[15px] leading-snug font-semibold text-text">
            {ticket.title}
          </h3>

          <div className="mb-3.5 flex flex-wrap gap-1.5">
            {/* The one chip in this row that is a control. Reporter, epic,
                story points and sprint stay plain text because none of them
                is writable here; the assignee is, so it stops being a label
                and becomes a button that says so. */}
            <JiraAssigneeChip
              assigneeName={ticket.assigneeName}
              disabled={ticket.hasConflict}
              disabledTitle="Write paused until reloaded"
              saving={savingAssignee}
              open={assigneeOpen}
              buttonRef={assigneeChipRef}
              onClick={() => setAssigneeOpen((o) => !o)}
            />
            {assigneeOpen && (
              <JiraAssigneePicker
                // The KEY, not the id: Jira's assignable-user search takes
                // `issueKey`, and this is the one call in the feature that
                // does. Everything else about this ticket travels by id.
                ticketKey={ticket.key}
                currentAssigneeAccountId={ticket.assigneeAccountId}
                triggerRef={assigneeChipRef}
                onSelect={handleSelectAssignee}
                onClose={() => setAssigneeOpen(false)}
              />
            )}
            <span className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
              Reporter · {ticket.reporterName}
            </span>
            {ticket.epicName && (
              <span className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
                Epic · {ticket.epicName}
              </span>
            )}
            {ticket.storyPoints != null && (
              <span className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
                Story points · {ticket.storyPoints}
              </span>
            )}
            {ticket.sprintName && (
              <span className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
                Sprint · {ticket.sprintName}
              </span>
            )}
          </div>

          {/* `whitespace-pre-wrap`, matching the comment bodies below.
              adfToPlainText already emits a \n per ADF block, which is the
              only structure that survives the flatten — and rendering it in
              a plain <p> collapsed every one of them, turning a
              multi-paragraph description with headings and bullets into a
              single run-on line. */}
          <p className="mb-3.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-text-secondary">
            {ticket.description}
          </p>

          {/* Rendered unconditionally, including on the common case of a
              ticket with nothing attached. The header is where "Attach a
              file" lives, so hiding it when the list is empty would hide the
              upload entry point exactly where a user is most likely to want
              it — the same reason the Comments header below it always shows
              even when there are no comments. */}
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-bold tracking-wide text-text-muted uppercase">
              Attachments
            </span>
            <button
              type="button"
              className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-2 hover:text-text disabled:opacity-60"
              disabled={uploading || ticket.hasConflict}
              title={
                ticket.hasConflict ? 'Write paused until reloaded' : undefined
              }
              onClick={handleUpload}
            >
              {uploading ? 'Uploading…' : 'Attach a file'}
            </button>
          </div>

          {ticket.attachments.length === 0 && (
            <p className="mb-4 text-[12.5px] text-text-muted">
              Nothing attached yet.
            </p>
          )}

          {ticket.attachments.map((a) => (
            <div
              // Jira lets two attachments on one issue share a filename —
              // upload `log.txt` twice and you get two of them — so the name
              // alone was a real key collision, not a theoretical one. The id
              // is unique per attachment; the name is only the fallback for an
              // attachment Jira returned without one.
              key={a.id ?? a.fileName}
              className="mb-4 flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-2.5 py-2 text-[11.5px] text-text-secondary"
            >
              <span className="font-mono text-[11px]">{a.fileName}</span>
              <span>
                · {a.sizeLabel} · {a.uploaderName}
              </span>
              {a.id ? (
                <button
                  type="button"
                  className="ml-auto shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold text-text-secondary hover:bg-surface-2 hover:text-text disabled:opacity-60"
                  disabled={downloading !== null}
                  onClick={() => handleDownload(a)}
                >
                  {downloading === a.id ? 'Saving…' : 'Download'}
                </button>
              ) : (
                // An attachment Jira returned without an id cannot be
                // addressed — the download URL is built from that id (see
                // main/jira/jiraClient.ts's downloadAttachment) — so this
                // says where it can be had rather than offering a button
                // whose only possible outcome is failing.
                <span
                  className="ml-auto shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold text-text-muted"
                  title="Jira didn't return an id for this attachment."
                >
                  download in Jira
                </span>
              )}
            </div>
          ))}

          <div className="mb-2 text-[11px] font-bold tracking-wide text-text-muted uppercase">
            Comments
          </div>
          <div className="mb-4 space-y-3.5">
            {comments.map((c) => (
              <div key={c.id} className="flex gap-2">
                <Avatar name={c.authorName} size={22} />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 text-xs">
                    <b className="font-semibold text-text">{c.authorName}</b>{' '}
                    <span className="text-text-muted">
                      {formatRelativeTime(c.createdAt)}
                      {c.postedByWaypoint ? ' · via Waypoint' : ''}
                    </span>
                  </div>
                  {c.disclosureText && (
                    <div className="mb-1 inline-block rounded bg-jira-bg px-1.5 py-0.5 text-[11px] text-jira">
                      {c.disclosureText}
                    </div>
                  )}
                  <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-text-secondary">
                    {c.body}
                  </div>
                </div>
              </div>
            ))}
            {commentsError && (
              <JiraLoadError
                compact
                what="this issue's comments"
                error={commentsError}
                onRetry={reloadComments}
              />
            )}
            {!commentsError && comments.length === 0 && (
              <p className="text-[12.5px] text-text-muted">No comments yet.</p>
            )}
          </div>

          <JiraCommentComposer
            ticketId={ticket.id}
            onPosted={(comment) => setComments((cs) => [...cs, comment])}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
