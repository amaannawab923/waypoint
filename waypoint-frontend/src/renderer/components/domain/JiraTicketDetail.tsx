import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  buildJiraCommentPermalink,
  deleteJiraComment,
  downloadJiraAttachment,
  getJiraCommentPermissions,
  getJiraPriorityOptions,
  getJiraTransitions,
  listJiraComments,
  setJiraTicketAssignee,
  setJiraTicketPriority,
  transitionJiraTicket,
  uploadJiraAttachment,
  type JiraCommentPermissions,
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
import {
  JiraCommentComposer,
  type JiraReplyTarget,
} from '@/components/domain/JiraCommentComposer';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import { JiraRichText } from '@/components/domain/JiraRichText';
import { jiraProjectColor } from '@/types/jira';
import type {
  JiraAttachment,
  JiraComment,
  JiraIssueLink,
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

// `iso` is null when Jira's payload omitted the comment's `created` — see
// JiraComment's own doc comment. Computing a duration against `null` would
// either throw or, worse, silently render some arbitrary elapsed time as
// truth; "Unknown" is the honest answer for a timestamp this app never had.
function formatRelativeTime(iso: string | null): string {
  if (iso === null) return 'Unknown';
  const diffMs = Date.now() - new Date(iso).getTime();
  // A present-but-unparseable string (Date.parse -> NaN) is the same
  // "unknown, not now" case as a genuinely missing one — without this,
  // every `<` comparison below is false on NaN and it falls out the bottom
  // as 'a while ago', silently claiming an elapsed time this app does not
  // actually know, exactly what the null check above exists to avoid.
  if (!Number.isFinite(diffMs)) return 'Unknown';
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
 * `ticket.dueDate` is date-only ("2026-09-14"), never a timestamp — see the
 * field's own doc comment on `JiraTicket`. Parsing it with `new Date(iso)`
 * reads it as UTC midnight, and `toLocaleDateString` then renders that in the
 * viewer's own zone, which rolls the date back a full day for anyone west of
 * UTC. Splitting the components and building a local `Date` from them keeps
 * the date Jira actually said rather than a zone-shifted neighbor of it.
 */
function formatDueDate(dateOnly: string): string {
  const parts = dateOnly.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return dateOnly;
  }
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return dateOnly;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Groups links by their already-resolved relation phrase ("blocks", "is
 * blocked by", …), preserving each relation's first-seen order rather than
 * sorting alphabetically — so the section reads in whatever order Jira's own
 * response listed the relations, not a reshuffled one. */
function groupLinksByRelation(
  links: JiraIssueLink[],
): Array<[string, JiraIssueLink[]]> {
  const grouped = new Map<string, JiraIssueLink[]>();
  for (const link of links) {
    const existing = grouped.get(link.relation);
    if (existing) {
      existing.push(link);
    } else {
      grouped.set(link.relation, [link]);
    }
  }
  return Array.from(grouped.entries());
}

/**
 * What a comment delete actually does, in the terms a confirm dialog has to
 * be honest about: `jira:comments:delete` (jiraIpc.ts -> jiraClient.ts's
 * `deleteComment`) removes the comment from the real issue outright, with no
 * undo on either side — Jira answers a plain 204 and there is nothing left
 * to restore it from. A standalone, exported function, the same shape
 * `disconnectJiraConfirmMessage` gives its own confirm text just below in
 * JiraConnectionPanel.tsx (and `archiveConfirmMessage` in
 * lib/projectArchiveCopy.ts before that) — "what this button actually does"
 * is worth stating once, and testably, rather than inlined at the one call
 * site that happens to exist today.
 *
 * Says plainly that this reaches Jira, not just Waypoint's own view of it:
 * a reader who has only ever seen this app delete rows locally (there is no
 * such feature here, but nothing stops the assumption) needs the sentence
 * that rules that reading out.
 */
export function deleteJiraCommentConfirmMessage(): string {
  return (
    'Delete this comment? This removes it from the real issue in Jira, not ' +
    'just from Waypoint, for anyone who has it open — and there is no undo.'
  );
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
  // Jira's own count for the issue, which `comments` can be a tail of. Held
  // separately rather than derived, because it is the one number the read
  // knows and the array cannot.
  const [commentTotal, setCommentTotal] = useState(0);
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
  // Set by a comment's Reply action and consumed by JiraCommentComposer's
  // own prefill effect (see that component's onReplyConsumed) — a fresh
  // object every click, deliberately, so a second Reply click (even to the
  // same author) is a real state change the composer's effect will see.
  const [pendingReply, setPendingReply] = useState<JiraReplyTarget | null>(
    null,
  );
  // Which comment's permalink was just copied, by id — mirrors
  // RequestsPage.tsx's own linkCopied flag, the one other "Copy link"
  // affordance in this app: this app's toast channel is error-only (see
  // showErrorToast), so a copy's own success has nowhere else to say so.
  // Cleared after the same 1500ms RequestsPage uses.
  const [copiedCommentId, setCopiedCommentId] = useState<string | null>(null);
  // Which comment is mid-delete, by id — same "one row, not a page-wide
  // boolean" shape as `downloading` above, since several rows could in
  // principle be clicked before the first confirm() resolves.
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
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
    if (!fetchedComments) return;
    setComments(fetchedComments.comments);
    setCommentTotal(fetchedComments.total);
  }, [fetchedComments]);

  // Delete's own visibility gate. `undefined` (not yet loaded, or the read
  // failed) means "no evidence of permission" and canDeleteComment below
  // reads it as false — fails closed, the same choice
  // getMyPermissions/havePermission already make in main for a permission
  // key Jira's own answer omitted. There is no error UI for this read: the
  // one thing a failure changes is that a destructive button stays hidden,
  // which is the safe direction to fail in and not worth a retry banner of
  // its own alongside the comment thread's real one.
  const { data: commentPermissions } = useAsync<JiraCommentPermissions>(
    () => getJiraCommentPermissions(ticket.key),
    [ticket.key],
  );

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

  /**
   * Copies one comment's real Jira permalink — verified live: this exact URL
   * shape scrolls Jira's own issue view straight to that comment. Silent on
   * failure, matching RequestsPage.tsx's own Copy link: clipboard access can
   * fail (unsupported browser, no permission), and there is nowhere for this
   * app's error-only toast channel to send a fabricated success in its
   * place — a mid-air "could not copy" for something this low-stakes is
   * worse than the button just staying "Copy link".
   */
  async function handleCopyCommentLink(commentId: string) {
    if (!connection?.site) return;
    const url = buildJiraCommentPermalink(
      connection.site,
      ticket.key,
      commentId,
    );
    try {
      await navigator.clipboard.writeText(url);
      setCopiedCommentId(commentId);
      setTimeout(() => setCopiedCommentId(null), 1500);
    } catch {
      // See the function's own comment above: a failed copy has no error
      // channel to report to and the address is not shown anywhere else in
      // this row for the user to fall back to reading it, unlike
      // RequestsPage's own input field — there is simply nothing more to do.
    }
  }

  /**
   * Whether Delete should render for this particular comment — a client-side
   * decision, since Jira's comment payload carries no per-comment permission
   * hint (see `commentPermissions`'s own comment above): the project-level
   * own/all answer, plus whether the signed-in account actually wrote this
   * one.
   *
   * `deleteAll` and `deleteOwn` can both be true on the same account (the
   * common shape for whoever is testing this against their own Jira, and NOT
   * the common shape a real non-admin sees) — so the `deleteOwn` branch below
   * is checked on its own rather than assumed from "deleteAll is false", the
   * one case this machine's own account cannot exercise by accident.
   */
  function canDeleteComment(comment: JiraComment): boolean {
    if (!commentPermissions) return false;
    if (commentPermissions.deleteAll) return true;
    if (!commentPermissions.deleteOwn) return false;
    return (
      comment.authorAccountId !== null &&
      comment.authorAccountId === connection?.accountId
    );
  }

  /**
   * Deletes one comment outright, after a confirm() naming exactly what that
   * does (see `deleteJiraCommentConfirmMessage`) — this repo's established
   * guard on every irreversible action, matching Disconnect's own
   * `window.confirm` in JiraConnectionPanel.tsx.
   *
   * On success the row is dropped from local state directly — `.filter()`,
   * not a refetch — because deleteJiraComment already told Jira to remove
   * it and this module holds no cache of the thread to reconcile against; a
   * refetch would just be a slower way to arrive at the same array. A
   * failure surfaces through the same error-only toast channel every other
   * write in this component uses, naming Jira's own message (a 403 from a
   * permission that changed since this comment's permissions were fetched,
   * or a 404 from someone else already deleting it) rather than pretending
   * nothing happened.
   */
  async function handleDeleteComment(comment: JiraComment) {
    if (!window.confirm(deleteJiraCommentConfirmMessage())) return;
    setDeletingCommentId(comment.id);
    try {
      await deleteJiraComment(ticket.id, comment.id);
      setComments((cs) => cs.filter((c) => c.id !== comment.id));
      setCommentTotal((t) => Math.max(0, t - 1));
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not delete that comment in Jira.',
      );
    } finally {
      setDeletingCommentId(null);
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

          {/* `whitespace-pre-wrap`, matching the comment bodies below —
              JiraRichText's own plain-text fallback is adfToPlainText's
              output, which emits a \n per ADF block, the only structure that
              survives the flatten. */}
          {ticket.description || ticket.descriptionAdf ? (
            <JiraRichText
              adf={ticket.descriptionAdf}
              fallback={ticket.description}
              className="mb-6 text-[13px] leading-relaxed whitespace-pre-wrap text-text-secondary"
            />
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

          <div className="mb-2 text-[11px] font-bold tracking-wide text-text-muted uppercase">
            Subtasks
          </div>
          {ticket.subtasks.length === 0 ? (
            <p className="mb-6 text-[12.5px] text-text-muted">No subtasks.</p>
          ) : (
            <div className="mb-6 space-y-2">
              {ticket.subtasks.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-2.5 py-2 text-[11.5px] text-text-secondary"
                >
                  <span className="shrink-0 font-mono text-[11px] font-semibold text-text-muted">
                    {s.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text">
                    {s.title}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: s.stateColor }}
                    />
                    <span className="text-[10.5px] font-semibold text-text-muted">
                      {s.stateName}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mb-2 text-[11px] font-bold tracking-wide text-text-muted uppercase">
            Linked work items
          </div>
          {ticket.links.length === 0 ? (
            <p className="mb-6 text-[12.5px] text-text-muted">
              No linked work items.
            </p>
          ) : (
            <div className="mb-6 space-y-3">
              {groupLinksByRelation(ticket.links).map(([relation, group]) => (
                <div key={relation}>
                  <div className="mb-1.5 text-[11px] font-semibold text-text-secondary capitalize">
                    {relation}
                  </div>
                  <div className="space-y-2">
                    {group.map((link) => (
                      <div
                        key={link.id}
                        className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-2.5 py-2 text-[11.5px] text-text-secondary"
                      >
                        <span
                          className="shrink-0 font-mono text-[11px] font-semibold"
                          style={{
                            color: jiraProjectColor(
                              link.key.split('-')[0] ?? '',
                            ),
                          }}
                        >
                          {link.key}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-text">
                          {link.title}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className="size-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: link.stateColor }}
                          />
                          <span className="text-[10.5px] font-semibold text-text-muted">
                            {link.stateName}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* No "Pending proposals" section here, unlike TicketDetailContent's
              native-ticket equivalent (MY_JIRA_IMPROVEMENTS.md §5 asked for
              parity if the data supported it — it doesn't, yet). ProposalView
              is origin-agnostic in shape, but every propose_* MCP tool
              (waypoint-backend/src/mcp/proposalTools.ts) resolves its
              `ticketId` through ticketsService.getTicket against this app's
              own Postgres `tickets` table — and Jira issues are never rows
              there (fetched live from Jira Cloud, no sync into that table,
              no `source` value for it either — see db/schema/tickets.ts).
              So a proposal's `ticketId` can equal a native Ticket.id but
              never a JiraTicket.id: Copilot cannot propose against a Jira
              issue today, at any layer, not just in this UI. Rendering an
              always-empty section here would be UI asserting a capability
              this app doesn't have — the honesty-lint rule the native
              section's own "no empty state" comment already follows in the
              other direction. Revisit once Copilot can actually target Jira
              issues (a real MCP tool + a ticketId scheme that reaches them),
              not before. */}
          <div className="mt-6 mb-2 text-[11px] font-bold tracking-wide text-text-muted uppercase">
            Comments
          </div>
          {/* Said before the thread, not after it: the whole failure this
              fixes is a reader finishing a partial thread believing it was
              the whole one. `total` comes from Jira rather than being
              inferred, so this can name the real number instead of hedging
              with "there are more". */}
          {commentTotal > comments.length && (
            <div className="mb-2.5 rounded-[var(--radius-sm)] border border-warning/30 bg-warning-bg px-3 py-2 text-[11.5px] leading-relaxed text-warning">
              Showing the {comments.length} most recent of {commentTotal}{' '}
              comments. Open this issue in Jira to read the rest.
            </div>
          )}
          <div className="mb-4 space-y-3.5">
            {comments.map((c) => (
              <div key={c.id} className="group flex gap-2">
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
                  {/* Three of Jira's five comment-row actions now: Reply and
                      Copy link, and Delete alongside them — permission-gated
                      per comment (see canDeleteComment above) rather than
                      always shown, since Jira's own comment menu only ever
                      offers delete on a comment you may actually remove.
                      Edit still needs a capability this phase deliberately
                      doesn't have, and reactions have no public API at all —
                      those two remain the honest gap. Opacity-revealed on
                      hover exactly like ProjectViewsPage.tsx's own row
                      actions, and group-focus-within (not group-hover alone)
                      is what keeps a keyboard user from needing a mouse to
                      ever see these — a Tab landing on any of these buttons
                      already reveals the row before it needs to be
                      clicked. */}
                  <div className="mt-1 flex items-center gap-2.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {c.authorAccountId !== null && (
                      <button
                        type="button"
                        onClick={() =>
                          setPendingReply({
                            accountId: c.authorAccountId as string,
                            displayName: c.authorName,
                          })
                        }
                        className="rounded text-[10.5px] font-semibold text-text-muted hover:text-text hover:underline"
                      >
                        Reply
                      </button>
                    )}
                    {jiraUrl && (
                      <button
                        type="button"
                        onClick={() => handleCopyCommentLink(c.id)}
                        className="rounded text-[10.5px] font-semibold text-text-muted hover:text-text hover:underline"
                      >
                        {copiedCommentId === c.id ? 'Copied' : 'Copy link'}
                      </button>
                    )}
                    {canDeleteComment(c) && (
                      <button
                        type="button"
                        disabled={deletingCommentId === c.id}
                        onClick={() => handleDeleteComment(c)}
                        className="rounded text-[10.5px] font-semibold text-text-muted hover:text-danger hover:underline disabled:opacity-60"
                      >
                        {deletingCommentId === c.id ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
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
            pendingReply={pendingReply}
            onReplyConsumed={() => setPendingReply(null)}
            onPosted={(comment) => {
              setComments((cs) => [...cs, comment]);
              // Otherwise posting into a truncated thread walks the notice's
              // own numbers together ("101 most recent of 312"), and on a
              // short thread it would invent a truncation that isn't there.
              setCommentTotal((t) => t + 1);
            }}
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

        <PropertyRow label="Labels">
          {ticket.labels.length === 0 ? (
            <ReadOnlyValue>
              <span className="text-text-muted">None</span>
            </ReadOnlyValue>
          ) : (
            <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
              {ticket.labels.map((label) => (
                <span
                  key={label}
                  className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-text-secondary"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
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

        <PropertyRow label="Due date">
          <ReadOnlyValue>
            {ticket.dueDate ? (
              formatDueDate(ticket.dueDate)
            ) : (
              <span className="text-text-muted">None</span>
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
