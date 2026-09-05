import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  downloadJiraAttachment,
  getJiraPriorityOptions,
  getJiraTransitions,
  listJiraComments,
  setJiraTicketAssignee,
  setJiraTicketPriority,
  transitionJiraTicket,
  uploadJiraAttachment,
} from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { useAsync } from '@/lib/useAsync';
import { useJiraConnection } from '@/lib/jiraStore';
import { Avatar } from '@/components/ui/Avatar';
import { Maximize2 } from 'lucide-react';
import { IconChevronRight, IconX } from '@/components/icons';
import {
  JiraAssigneeChip,
  JiraAssigneePicker,
} from '@/components/domain/JiraAssigneePicker';
import {
  JiraPriorityChip,
  JiraPriorityPicker,
} from '@/components/domain/JiraPriorityPicker';
import {
  JiraStateChip,
  JiraTransitionPopover,
} from '@/components/domain/JiraTransitionPopover';
import { JiraCommentComposer } from '@/components/domain/JiraCommentComposer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import { jiraProjectColor } from '@/types/jira';
import type {
  JiraAttachment,
  JiraComment,
  JiraPriorityOption,
  JiraTicket,
  JiraTransition,
} from '@/types/jira';

// One Jira issue's full detail, rendered either as the right-hand peek panel
// or as a full page — the same split (and the same `variant` prop) that
// pages/tickets/TicketDetailPage.tsx's own TicketDetailContent already uses
// for this app's native tickets, deliberately rather than a second layout
// convention for the Jira side. A Jira issue and a native ticket are the
// same *kind* of thing to look at, so looking at one shouldn't feel like a
// different product.
//
// The layout difference is the whole point of the variant: docked, this is
// one scrolling column with the properties stacked underneath; expanded, it
// is a two-column page with the properties in their own right-hand rail.
// Expanding is a real navigation to /my-jira/:key, not a wider drawer —
// again matching the native ticket, whose expand button leaves the drawer
// for /projects/:projectId/tickets/:identifier.

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

/** Label + value, on the same 104px label column TicketDetailPage's own
 * PropertyRow uses — the two panels sit one route apart and should line up. */
function PropertyRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-1.5 w-[104px] shrink-0 text-xs text-text-muted">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A property whose value Jira owns and this app doesn't write — rendered as
 * plain text at the same height as the editable rows so the column doesn't
 * visibly jump between "you can change this" and "you can't". */
function ReadOnlyValue({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-8 items-center px-2 text-sm text-text">
      {children}
    </div>
  );
}

export function JiraTicketDetail({
  ticket,
  variant = 'page',
  onTicketUpdated,
  onClose,
  onExpand,
}: {
  ticket: JiraTicket;
  variant?: 'drawer' | 'page';
  onTicketUpdated: (updated: JiraTicket) => void;
  /** Drawer only — the page has no close button, it has a back route. */
  onClose?: () => void;
  /** Drawer only. Absent on the page, which is already expanded. */
  onExpand?: () => void;
}) {
  const isDrawer = variant === 'drawer';
  const [comments, setComments] = useState<JiraComment[]>([]);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [savingAssignee, setSavingAssignee] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [loadingTransitions, setLoadingTransitions] = useState(false);
  const [transitionsError, setTransitionsError] = useState<Error | null>(null);
  const [savingState, setSavingState] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [priorityOptions, setPriorityOptions] = useState<JiraPriorityOption[]>(
    [],
  );
  const [loadingPriorities, setLoadingPriorities] = useState(false);
  const [prioritiesError, setPrioritiesError] = useState<Error | null>(null);
  const [savingPriority, setSavingPriority] = useState(false);
  // Which attachment is mid-download, by id — not a plain boolean, because a
  // ticket can have several rows and only the one that was clicked should say
  // "Saving…".
  const [downloading, setDownloading] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const assigneeChipRef = useRef<HTMLButtonElement>(null);
  const stateChipRef = useRef<HTMLButtonElement>(null);
  const priorityChipRef = useRef<HTMLButtonElement>(null);
  const connection = useJiraConnection();

  const {
    data: fetchedComments,
    error: commentsError,
    reload: reloadComments,
  } = useAsync(() => listJiraComments(ticket.id), [ticket.id]);
  useEffect(() => {
    if (fetchedComments) setComments(fetchedComments);
  }, [fetchedComments]);

  // Both lazy reads follow JiraTicketRow's own shape exactly, including the
  // `.catch()`: without one, a broken connection renders as "no transitions
  // available" / "no priority options here", which are claims about the
  // user's Jira that a failed request cannot support.
  useEffect(() => {
    if (!stateOpen) return undefined;
    let cancelled = false;
    setLoadingTransitions(true);
    setTransitionsError(null);
    getJiraTransitions(ticket.id)
      .then((rows) => {
        if (!cancelled) setTransitions(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTransitions([]);
        setTransitionsError(
          err instanceof Error ? err : new Error(String(err)),
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingTransitions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stateOpen, ticket.id]);

  useEffect(() => {
    if (!priorityOpen) return undefined;
    let cancelled = false;
    setLoadingPriorities(true);
    setPrioritiesError(null);
    getJiraPriorityOptions(ticket.id)
      .then((rows) => {
        if (!cancelled) setPriorityOptions(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPriorityOptions([]);
        setPrioritiesError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoadingPriorities(false);
      });
    return () => {
      cancelled = true;
    };
  }, [priorityOpen, ticket.id]);

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

  async function handleSelectTransition(
    transition: JiraTransition,
    fieldValues: Record<string, string>,
  ) {
    setStateOpen(false);
    setSavingState(true);
    try {
      onTicketUpdated(
        await transitionJiraTicket(ticket.id, transition.id, fieldValues),
      );
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not move this ticket in Jira.',
      );
    } finally {
      setSavingState(false);
    }
  }

  async function handleSelectPriority(option: JiraPriorityOption) {
    setPriorityOpen(false);
    setSavingPriority(true);
    try {
      onTicketUpdated(await setJiraTicketPriority(ticket.id, option.id));
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : "Could not change this ticket's priority in Jira.",
      );
    } finally {
      setSavingPriority(false);
    }
  }

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

  const projectColor = jiraProjectColor(ticket.projectKey);
  const jiraUrl = connection?.site
    ? `https://${connection.site}/browse/${ticket.key}`
    : null;

  return (
    <div
      className={clsx(
        isDrawer
          ? 'flex h-full flex-col overflow-y-auto'
          : 'mx-auto flex max-w-[1400px] flex-col md:flex-row',
      )}
    >
      <div
        className={clsx(
          'min-w-0 flex-1',
          !isDrawer && 'md:border-r md:border-border',
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-6 py-3.5">
          {isDrawer ? (
            <span
              className="font-mono text-xs font-bold"
              style={{ color: projectColor }}
            >
              {ticket.key}
            </span>
          ) : (
            // The page gets breadcrumbs in the same shape the native ticket
            // page uses, so "where am I" reads identically on both.
            <div className="flex min-w-0 items-center gap-1.5 text-sm text-text-secondary">
              <span className="shrink-0">My Jira</span>
              <IconChevronRight
                size={14}
                className="shrink-0 text-text-muted"
              />
              <span
                className="shrink-0 font-mono font-bold"
                style={{ color: projectColor }}
              >
                {ticket.key}
              </span>
            </div>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {jiraUrl && (
              <a
                href={jiraUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded px-2 py-1 text-xs font-semibold text-text-secondary hover:bg-surface-2 hover:text-text"
              >
                Open in Jira ↗
              </a>
            )}
            {onExpand && (
              <button
                type="button"
                aria-label="Open full page"
                title="Open full page"
                onClick={onExpand}
                className="flex size-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
              >
                <Maximize2 size={15} />
              </button>
            )}
            {onClose && (
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="flex size-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
              >
                <IconX size={16} />
              </button>
            )}
          </div>
        </div>

        <div className="px-6 py-5">
          <h3 className="mb-3 font-display text-[19px] leading-snug font-semibold text-text">
            {ticket.title}
          </h3>

          {/* `whitespace-pre-wrap`, matching the comment bodies below.
              adfToPlainText already emits a \n per ADF block, which is the
              only structure that survives the flatten — and rendering it in
              a plain <p> collapsed every one of them. */}
          {ticket.description ? (
            <p className="mb-6 text-[13px] leading-relaxed whitespace-pre-wrap text-text-secondary">
              {ticket.description}
            </p>
          ) : (
            <p className="mb-6 text-[13px] text-text-muted">No description.</p>
          )}

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
            <p className="mb-6 text-[12.5px] text-text-muted">
              Nothing attached yet.
            </p>
          )}

          {ticket.attachments.map((a) => (
            <div
              // Jira lets two attachments on one issue share a filename, so
              // the name alone was a real key collision. The id is unique;
              // the name is only the fallback for one Jira returned without.
              key={a.id ?? a.fileName}
              className="mb-2 flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-2.5 py-2 text-[11.5px] text-text-secondary"
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
                <span
                  className="ml-auto shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold text-text-muted"
                  title="Jira didn't return an id for this attachment."
                >
                  download in Jira
                </span>
              )}
            </div>
          ))}

          <div className="mt-6 mb-2 text-[11px] font-bold tracking-wide text-text-muted uppercase">
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
            {/* "No comments yet." is a positive claim about this issue —
                rendering it because the read failed would say the thread is
                empty when the truth is Waypoint never saw it. */}
            {!commentsError && comments.length === 0 && (
              <p className="text-[12.5px] text-text-muted">No comments yet.</p>
            )}
          </div>

          <JiraCommentComposer
            ticketId={ticket.id}
            ticketKey={ticket.key}
            attachments={ticket.attachments}
            onTicketUpdated={onTicketUpdated}
            onPosted={(comment) => setComments((cs) => [...cs, comment])}
          />
        </div>
      </div>

      {/* Properties. Stacked under the content in the drawer, its own rail on
          the page — the same `md:w-[300px]` rail the native ticket uses. */}
      <aside
        className={clsx(
          'w-full shrink-0 border-t border-border px-6 py-5',
          !isDrawer &&
            'md:w-[300px] md:self-start md:border-t-0 md:px-5 md:py-6',
        )}
      >
        <PropertyRow label="State">
          <div className="relative">
            <JiraStateChip
              stateName={ticket.stateName}
              stateColor={ticket.stateColor}
              disabled={ticket.hasConflict}
              disabledTitle="Write paused until reloaded"
              saving={savingState}
              open={stateOpen}
              buttonRef={stateChipRef}
              onClick={() => setStateOpen((o) => !o)}
            />
            {stateOpen && (
              <JiraTransitionPopover
                ticketKey={ticket.key}
                projectKey={ticket.projectKey}
                currentStateName={ticket.stateName}
                transitions={transitions}
                loading={loadingTransitions}
                error={transitionsError}
                triggerRef={stateChipRef}
                onSelect={handleSelectTransition}
                onClose={() => setStateOpen(false)}
              />
            )}
          </div>
        </PropertyRow>

        <PropertyRow label="Assignee">
          <div className="relative">
            <JiraAssigneeChip
              assigneeName={ticket.assigneeName}
              disabled={ticket.hasConflict}
              disabledTitle="Write paused until reloaded"
              saving={savingAssignee}
              open={assigneeOpen}
              compact
              buttonRef={assigneeChipRef}
              onClick={() => setAssigneeOpen((o) => !o)}
            />
            {assigneeOpen && (
              <JiraAssigneePicker
                // The KEY, not the id: Jira's assignable-user search takes
                // `issueKey`, and this is the one call in the feature that does.
                ticketKey={ticket.key}
                currentAssigneeAccountId={ticket.assigneeAccountId}
                triggerRef={assigneeChipRef}
                onSelect={handleSelectAssignee}
                onClose={() => setAssigneeOpen(false)}
              />
            )}
          </div>
        </PropertyRow>

        <PropertyRow label="Priority">
          <div className="relative flex items-center gap-2">
            <JiraPriorityChip
              priority={ticket.priority}
              priorityName={ticket.priorityName}
              disabled={ticket.hasConflict}
              disabledTitle="Write paused until reloaded"
              saving={savingPriority}
              open={priorityOpen}
              buttonRef={priorityChipRef}
              onClick={() => setPriorityOpen((o) => !o)}
            />
            <span className="truncate text-sm text-text">
              {ticket.priorityName}
            </span>
            {priorityOpen && (
              <JiraPriorityPicker
                ticketKey={ticket.key}
                currentPriorityId={ticket.priorityId}
                options={priorityOptions}
                loading={loadingPriorities}
                error={prioritiesError}
                triggerRef={priorityChipRef}
                onSelect={handleSelectPriority}
                onClose={() => setPriorityOpen(false)}
              />
            )}
          </div>
        </PropertyRow>

        <PropertyRow label="Reporter">
          <ReadOnlyValue>
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="flex shrink-0">
                <Avatar name={ticket.reporterName} size={20} />
              </span>
              <span className="truncate">{ticket.reporterName}</span>
            </span>
          </ReadOnlyValue>
        </PropertyRow>

        <PropertyRow label="Epic">
          <ReadOnlyValue>
            {ticket.epicName ?? <span className="text-text-muted">None</span>}
          </ReadOnlyValue>
        </PropertyRow>

        <PropertyRow label="Sprint">
          <ReadOnlyValue>
            {ticket.sprintName ?? <span className="text-text-muted">None</span>}
          </ReadOnlyValue>
        </PropertyRow>

        <PropertyRow label="Story points">
          <ReadOnlyValue>
            {ticket.storyPoints ?? (
              <span className="text-text-muted">No estimate</span>
            )}
          </ReadOnlyValue>
        </PropertyRow>

        <PropertyRow label="Your role">
          <ReadOnlyValue>
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-text-muted uppercase">
              {ticket.role === 'none' ? 'not yours' : ticket.role}
            </span>
          </ReadOnlyValue>
        </PropertyRow>
      </aside>
    </div>
  );
}
