import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  buildJiraCommentPermalink,
  deleteJiraComment,
  downloadJiraAttachment,
  getJiraComment,
  getJiraCommentPermissions,
  getJiraPriorityOptions,
  getJiraTransitions,
  listJiraComments,
  prepareJiraCommentEdit,
  setJiraTicketAssignee,
  setJiraTicketPriority,
  transitionJiraTicket,
  uploadJiraAttachment,
  type JiraCommentPermissions,
  type JiraMentionSpan,
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
  type JiraEditTarget,
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

/** One top-level comment plus every reply grouped under it, flattened to
 * exactly one level — see `groupCommentsIntoThreads`'s own comment for why
 * this shape has no further nesting inside `replies`. */
export interface JiraCommentThread {
  root: JiraComment;
  replies: JiraComment[];
}

/**
 * Groups a comment page into threads by `parentId`, capped at one visible
 * level of nesting — a root, plus every comment that traces back to it, all
 * rendered as direct replies regardless of how many hops deep the real chain
 * is. That matches what Jira itself shows (the founder's own ENG-84
 * screenshot has one level of nesting, not an indent per reply-to-a-reply),
 * and it is what keeps a long or malformed chain from pushing content off
 * the right edge of the panel one indent at a time.
 *
 * Two things this must never do, because the 100-comment page it reads from
 * (COMMENT_PAGE_SIZE in jiraClient.ts) is exactly where both happen:
 *
 *  - Drop a comment whose parent isn't on this page. A reply's `parentId`
 *    can name a real comment that simply fell outside the cap — that comment
 *    renders as its own root instead of vanishing. A dropped comment is a
 *    bug; being placed one level higher than Jira's own view shows it is
 *    cosmetic.
 *  - Hang, or drop every comment in it, on a cyclic or self-referencing
 *    `parentId`. The data is never assumed well-formed: `findRootId` below
 *    walks at most `comments.length` hops and gives up the moment it would
 *    revisit a comment already in its own walk, at which point the comment
 *    the walk STARTED from becomes its own root. Every member of an N-comment
 *    cycle ends up a root of its own with no replies — flat, not nested in an
 *    arbitrary or wrong order, and never a hang.
 */
export function groupCommentsIntoThreads(
  comments: JiraComment[],
): JiraCommentThread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));

  function findRootId(start: JiraComment): string {
    // Every comment visited on THIS walk, so a repeat means a cycle rather
    // than a coincidence — two different comments having replied to the same
    // parent is normal and must not trip this.
    const seen = new Set<string>([start.id]);
    let current = start;
    // A second, independent bound on top of the cycle check above: even a
    // bug in that check cannot turn this into an infinite loop, since a walk
    // this long has already visited every comment there is.
    for (let steps = 0; steps < comments.length; steps += 1) {
      if (!current.parentId) return current.id;
      const parent = byId.get(current.parentId);
      // The named parent isn't on this page — an orphan. `current`, not
      // `start`, is the root: everything already walked between them is
      // still a real, resolvable chain and stays grouped together under
      // this same boundary.
      if (!parent) return current.id;
      // A parent already seen on this walk closes a cycle. There is no
      // well-defined "real" root inside one, so this breaks it at the
      // comment the walk started from rather than guessing which member of
      // the cycle deserves to be treated as the top.
      if (seen.has(parent.id)) return start.id;
      seen.add(parent.id);
      current = parent;
    }
    return start.id;
  }

  const rootOrder: string[] = [];
  const repliesByRoot = new Map<string, JiraComment[]>();

  comments.forEach((c) => {
    const rootId = findRootId(c);
    if (rootId === c.id) {
      rootOrder.push(c.id);
    } else {
      const existing = repliesByRoot.get(rootId);
      if (existing) existing.push(c);
      else repliesByRoot.set(rootId, [c]);
    }
  });

  return rootOrder.map((id) => ({
    // Non-null: `id` only ever entered rootOrder as some comment's own id.
    root: byId.get(id) as JiraComment,
    replies: repliesByRoot.get(id) ?? [],
  }));
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

/**
 * What `refreshAndFindComment` below can conclude about one named comment.
 *
 * `'unavailable'` means exactly what `getJiraComment` returning `null`
 * means, and nothing more: Jira answered 404 for this comment. It is NOT
 * "this comment was deleted" — Atlassian answers 404 rather than 403 for a
 * comment the account may no longer browse (see `getJiraComment`'s own doc
 * comment in data/jiraApi.ts), so a permission change and a real deletion
 * are indistinguishable from here. Every message built on this status has
 * to allow for both causes rather than asserting the first as fact.
 */
type CommentFreshness =
  { status: 'found'; comment: JiraComment } | { status: 'unavailable' };

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
  // Set by a comment's Reply action and consumed by the composer above the
  // thread's own prefill effect (see JiraCommentComposer's onReplyConsumed)
  // — a fresh object every click, deliberately, so a second Reply click
  // (even to the same author) is a real state change the composer's effect
  // will see. Reply always targets that one composer — see JiraCommentComposer
  // itself for why a reply is a new (if nested) comment, not an edit.
  const [pendingReply, setPendingReply] = useState<JiraReplyTarget | null>(
    null,
  );
  // Which comment currently has its OWN inline JiraCommentComposer mounted
  // in place of its body (see renderComment below), and what to prefill it
  // with. Unlike pendingReply, this is not a one-shot signal consumed the
  // instant it's loaded: it stays set for the whole editing session, because
  // it doubles as the render condition that keeps that one comment's inline
  // editor mounted. It is cleared — unmounting the editor and restoring the
  // comment's own rendered body — by closeInlineEdit below, on Cancel or on
  // a successful save.
  //
  // Mutually exclusive with pendingReply, the same property the two shared
  // on one composer before this composer split in two: starting an Edit
  // clears pendingReply (see the Edit handler in renderComment) and bumps
  // editGeneration to reset the reply composer's own draft, and starting a
  // Reply clears pendingEdit (unmounting whatever comment's inline editor
  // was open, discarding any unsaved edit there).
  const [pendingEdit, setPendingEdit] = useState<JiraEditTarget | null>(null);
  // Remounts the composer above the thread (via its `key` below) whenever an
  // Edit starts, so that composer's own in-progress draft — a reply prefill
  // or a plain typed comment — is abandoned rather than left showing behind
  // an unrelated inline edit. Mirrors exactly what this component's single
  // shared composer already did before the split: loading an edit always
  // replaced that composer's whole draft, regardless of what was in it.
  const [editGeneration, setEditGeneration] = useState(0);
  // One comment's own Edit trigger button, by comment id — read by
  // closeInlineEdit so Cancel (and a successful Save) can put focus back on
  // it rather than letting it fall to <body> once the inline editor
  // unmounts and takes the focus that was inside it along with it.
  const editButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  /** Unmounts whichever comment's inline editor is open and returns focus to
   * that comment's own Edit button — the shared ending for both Cancel and a
   * successful Save, since both leave the thread with nothing being edited
   * and nowhere obvious for focus to land on its own. Deferred a frame so the
   * Edit button this focuses has already been re-rendered: it doesn't exist
   * in the DOM until the state update below removes the inline editor that
   * was standing in its place. */
  function closeInlineEdit(commentId: string) {
    setPendingEdit(null);
    requestAnimationFrame(() => {
      editButtonRefs.current.get(commentId)?.focus();
    });
  }
  // Which comment's permalink was just copied, by id — mirrors
  // RequestsPage.tsx's own linkCopied flag, the one other "Copy link"
  // affordance in this app: this app's toast channel is error-only (see
  // showErrorToast), so a copy's own success has nowhere else to say so.
  // Cleared after the same 1500ms RequestsPage uses.
  const [copiedCommentId, setCopiedCommentId] = useState<string | null>(null);
  // Which comment is mid-delete, by id — same "one row, not a page-wide
  // boolean" shape as `downloading` above, since several rows could in
  // principle be clicked before the first confirm() resolves. Also covers
  // the live freshness re-read handleDeleteComment now does before the
  // actual delete call (see that function's own comment) — from the user's
  // perspective both are the same "Deleting…" operation.
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  // Which comment's Edit click is mid-flight, by id — the live re-read
  // handleEditClick (in renderComment below) does before opening the inline
  // editor, same "one row" shape as `deletingCommentId` above. Read by the
  // Edit button itself to show "Checking…" rather than nothing while the
  // network round trip it now requires is in flight.
  const [checkingEditId, setCheckingEditId] = useState<string | null>(null);
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

  /**
   * The freshness re-check both the Edit-open guard and the Delete guard
   * below share — see those two call sites for why each needs one, and
   * renderComment's own comment by the action row below for why neither
   * trusts `ticket.hasConflict` for it instead (too blunt: that flag trips
   * on ANY field on the ISSUE drifting, including one with nothing to do
   * with this comment, and blocking every comment action over an unrelated
   * priority change would be exactly the false-positive pattern that gets a
   * safety feature learned-ignored).
   *
   * Two reads, for two different jobs, fired together. The verdict on THIS
   * comment — still there, or Jira won't show it any more — comes from
   * `getJiraComment`, which names the comment and therefore cannot miss it.
   * It used to come from searching the array `listJiraComments` returns,
   * but that read is capped at the newest COMMENT_PAGE_SIZE (100) comments,
   * so "absent from the page" was produced by two completely different
   * situations — a real deletion, and a comment that simply scrolled off a
   * busy thread — and this function told the caller the first no matter
   * which one had actually happened. `listJiraComments` still runs
   * alongside it, because it is the only read that keeps the on-screen
   * thread itself current, and both call sites' "gone" messages want to say
   * "the thread above now shows the latest version" and have that be true.
   *
   * This only ever runs from an explicit user action (an Edit click, a
   * confirmed Delete), never on render, so paying for both reads at once is
   * worth it — but they are deliberately `Promise.allSettled`, not a bare
   * `Promise.all`. A bare `Promise.all` rejects the instant `getJiraComment`
   * rejects and would lose a `listJiraComments` result that had already come
   * back fine, silently dropping a real thread refresh for a reason that has
   * nothing to do with the refresh itself. `allSettled` keeps the two
   * outcomes independent: the thread refresh below is applied whenever ITS
   * OWN read succeeded, regardless of what happened to the other one, and
   * each read's own failure is re-thrown from here so it still reaches the
   * caller's existing catch/showErrorToast path — including a failed
   * `listJiraComments`, since a "the thread above now shows the latest
   * version" message would itself be false if that read never landed.
   */
  async function refreshAndFindComment(
    commentId: string,
  ): Promise<CommentFreshness> {
    const [listResult, commentResult] = await Promise.allSettled([
      listJiraComments(ticket.id),
      getJiraComment(ticket.id, commentId),
    ]);

    // Resolved before the refresh below, because it decides what that
    // refresh is allowed to drop. Only a comment the named read actually
    // returned counts here — a rejected read is not evidence of anything
    // (it re-throws a few lines down) and must not be read as "gone".
    const named =
      commentResult.status === 'fulfilled' ? commentResult.value : null;

    if (listResult.status === 'fulfilled') {
      const page = listResult.value.comments;
      // The page and the named comment can genuinely disagree: the page is
      // the newest COMMENT_PAGE_SIZE comments, so the very comment being
      // edited or deleted can be missing from it while unmistakably still
      // existing — which is the whole reason the named read was added. When
      // that happens, showing the page verbatim would make the comment
      // vanish from the thread the instant its Edit button was clicked, and
      // leave the in-place editor (which renders inside that comment's own
      // row) with nowhere to appear. Worse, a comment disappearing on click
      // reads as "it was deleted" just as strongly as the message this
      // whole change removed — so keeping it is the honest render, not a
      // convenience: it is there, and this is its current content.
      //
      // Prepended rather than inserted at a guessed index: comments are
      // ordered oldest-first, and a comment absent from the newest page is
      // necessarily older than every comment on it.
      const missingFromPage =
        named !== null && !page.some((c) => c.id === named.id);
      setComments(missingFromPage && named ? [named, ...page] : page);
      setCommentTotal(listResult.value.total);
    }

    // Both failures propagate rather than resolving to 'unavailable' — that
    // status is reserved for the one specific fact a `null` from
    // getJiraComment proves (Jira answered 404), never for "the request
    // failed", which is a completely different situation with its own
    // error-toast path already in place at both call sites below.
    if (commentResult.status === 'rejected') {
      throw commentResult.reason;
    }
    if (listResult.status === 'rejected') {
      throw listResult.reason;
    }

    const comment = commentResult.value;
    return comment ? { status: 'found', comment } : { status: 'unavailable' };
  }

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
   * Whether Edit should render for this particular comment at all — the
   * same shape as `canDeleteComment` just above, and for the same reason:
   * Jira's comment payload carries no per-comment permission hint, so this
   * is the project-level own/all answer plus whether the signed-in account
   * actually wrote this one.
   *
   * `editAll` and `editOwn` can both be true on the same account — the
   * common shape for whoever is testing this against their own Jira,
   * INCLUDING the account this feature was developed on — so the
   * `editOwn` branch below is checked on its own rather than assumed from
   * "editAll is false", the one case this machine's own account cannot
   * exercise by accident.
   *
   * This decides only whether Edit may be OFFERED. Whether it's SAFE to
   * offer for this comment's own content — whether it can be turned back
   * into ADF without changing it — is a separate question `canEditComment`
   * does not answer; see `prepareJiraCommentEdit` in renderComment below.
   */
  function canEditComment(comment: JiraComment): boolean {
    if (!commentPermissions) return false;
    if (commentPermissions.editAll) return true;
    if (!commentPermissions.editOwn) return false;
    return (
      comment.authorAccountId !== null &&
      comment.authorAccountId === connection?.accountId
    );
  }

  /**
   * `prepareJiraCommentEdit`'s own answer per comment, computed once per
   * `comments` array change rather than inline in `renderComment` on every
   * render — found in review: that ran on every render, for every comment
   * whose author may edit it, walking and re-serialising that comment's
   * whole ADF tree even when nothing about the comment or the render had
   * anything to do with editing (a hover, an unrelated picker opening, a
   * download finishing, ...). `comments` only gets a new array reference
   * when its content actually changes (a post, an edit landing, a delete, or
   * one of the live freshness re-reads below), so this recomputes exactly as
   * often as there is new data for it to be computed from.
   *
   * Gated on `canEditComment`, matching `renderComment`'s own gating below:
   * a comment nobody may edit is never worth the round trip through this
   * function, and callers that assert `prepareJiraCommentEdit` is never
   * invoked for a permission-denied comment depend on that staying true.
   */
  const editPreviewsByCommentId = useMemo(() => {
    const map = new Map<
      string,
      { text: string; mentions: JiraMentionSpan[] } | null
    >();
    comments
      .filter((c) => canEditComment(c))
      .forEach((c) => map.set(c.id, prepareJiraCommentEdit(c)));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, commentPermissions, connection?.accountId]);

  /**
   * Deletes one comment outright, after a confirm() naming exactly what that
   * does (see `deleteJiraCommentConfirmMessage`) — this repo's established
   * guard on every irreversible action, matching Disconnect's own
   * `window.confirm` in JiraConnectionPanel.tsx.
   *
   * Re-checks the comment is still what's on screen immediately before the
   * actual delete call, via `refreshAndFindComment` — the same guard, and
   * the same reasoning, as the Edit save path in JiraCommentComposer.tsx's
   * handlePost: delete has no undo (see `deleteJiraCommentConfirmMessage`),
   * so a comment whose content changed in the window between this row
   * rendering and the confirm dialog closing may no longer be the content
   * the person confirming actually saw. Checked here rather than before
   * `window.confirm`, deliberately: the network round trip is only worth
   * paying once the user has actually said yes, not on every render or on a
   * confirm they're about to cancel.
   *
   * On success the row is dropped from local state directly — `.filter()`
   * over the just-refreshed array, not a second refetch — because
   * deleteJiraComment already told Jira to remove it. A failure surfaces
   * through the same error-only toast channel every other write in this
   * component uses, naming Jira's own message (a 403 from a permission that
   * changed since this comment's permissions were fetched, or a 404 — which
   * says only that Jira will not show this comment, not that someone else
   * already deleted it; see CommentFreshness's own comment) rather than
   * pretending nothing happened.
   */
  async function handleDeleteComment(comment: JiraComment) {
    if (!window.confirm(deleteJiraCommentConfirmMessage())) return;
    setDeletingCommentId(comment.id);
    try {
      const freshness = await refreshAndFindComment(comment.id);
      if (freshness.status === 'unavailable') {
        // Jira answered 404 for this exact comment — not "absent from a
        // capped listJiraComments page", which is what this guard used to
        // infer deletion from and which a busy thread produces just as
        // easily by scrolling the comment off the newest 100. Even a named
        // 404 doesn't prove a deletion happened (see CommentFreshness's own
        // comment: Atlassian answers 404 for a permission change too), so
        // this can't claim one either way. What it CAN say: nothing was
        // deleted by this click, and the user who just confirmed a
        // destructive action deserves to hear that rather than silence —
        // silently returning here used to leave them with no idea whether
        // their delete went through.
        showErrorToast(
          "Jira won't show this comment any more — it was deleted, or you no longer have permission to see it. Nothing was deleted just now; the thread above shows the latest version.",
        );
        return;
      }
      const freshComment = freshness.comment;
      if (
        comment.updatedAt !== null &&
        freshComment.updatedAt !== null &&
        freshComment.updatedAt !== comment.updatedAt
      ) {
        // Either side being null means "unknown", which this file's own
        // hasConflict gating already treats as no evidence of drift rather
        // than proof of it — the same call made here, for the same reason:
        // a false refusal on missing data is the false positive that gets a
        // safety feature learned-ignored.
        showErrorToast(
          'This comment changed in Jira since you opened this view, so the delete was stopped rather than remove content you have not seen. The thread above now shows the latest version — delete again if you still want to.',
        );
        return;
      }
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

  /** One comment row — the whole per-comment block `groupCommentsIntoThreads`
   * below renders twice over (once for a thread's root, once per reply in
   * it), pulled out so both call sites stay identical rather than drifting
   * apart the way a root row and a reply row easily could if this were
   * inlined twice. Not module-scope: it closes over this render's handlers
   * and state (canDeleteComment, copiedCommentId, ...) the same way
   * PropertyRow above does NOT need to, because PropertyRow needs none of
   * them. */
  function renderComment(c: JiraComment) {
    // Whether THIS comment's own inline editor is the one pendingEdit
    // names — pendingEdit is a single value, so at most one comment in the
    // whole thread ever satisfies this at a time. See pendingEdit's own
    // comment above for why this stays true for the whole editing session
    // rather than going null the instant the prefill loads.
    const isEditing = pendingEdit?.commentId === c.id;
    return (
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
          {isEditing && pendingEdit ? (
            // Replaces this one comment's own body and action row with a
            // real composer, right where the comment already sits — matching
            // Jira's own inline edit (verified live against ENG-84: Edit
            // swaps the comment's body for an editor in place, not a shared
            // box elsewhere in the thread). Everything else in the thread,
            // including every other comment's own position, is untouched.
            //
            // A fresh JiraCommentComposer instance, mounted only while
            // isEditing is true for this one comment: it gets no
            // onEditConsumed (nothing here needs pendingEdit nulled the
            // instant the prefill loads — closeInlineEdit, wired to Cancel
            // and to a successful Save below, is what unmounts this) and no
            // pendingReply (Reply always targets the composer above the
            // thread, never this one — see that composer's own JSX below).
            <JiraCommentComposer
              ticketId={ticket.id}
              ticketKey={ticket.key}
              attachments={ticket.attachments}
              onTicketUpdated={onTicketUpdated}
              pendingEdit={pendingEdit}
              onEdited={(comment) => {
                // Same "trust the response, not the request" rule the
                // composer above the thread already follows for onPosted:
                // replaces the row with whatever Jira's own write response
                // describes, not the text this instance happened to submit.
                setComments((cs) =>
                  cs.map((x) => (x.id === comment.id ? comment : x)),
                );
                closeInlineEdit(c.id);
              }}
              onEditCancelled={() => closeInlineEdit(c.id)}
            />
          ) : (
            <>
              {/* ROAD-27 / docs/qa/manual-test-cases.md's JIRA-155: a comment
                  body is plain text (not routed through JiraRichText, unlike
                  the description below), so it needs its own `break-words`
                  — same choice and same reasoning as JiraRichText's root
                  (prefers a whitespace break, only splits a pasted stack
                  trace / base64 blob / long URL mid-token when there is
                  nowhere else to break). It only takes effect because the
                  comment's own column above is already `min-w-0 flex-1`
                  (see renderComment's outer div) — without that, this flex
                  item would refuse to shrink below the unbroken token's
                  width in the first place, and break-words would have
                  nothing to work with. */}
              <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-text-secondary">
                {c.body}
              </div>
              {/* Four of Jira's five comment-row actions now: Reply, Edit,
                  Copy link, and Delete — permission-gated per comment
                  (see canDeleteComment/canEditComment above) rather than
                  always shown, since Jira's own comment menu only ever
                  offers delete/edit on a comment you may actually change.
                  Reactions have no public API at all and remain the one
                  honest gap. Opacity-revealed on hover exactly like
                  ProjectViewsPage.tsx's own row actions, and
                  group-focus-within (not group-hover alone) is what keeps
                  a keyboard user from needing a mouse to ever see these —
                  a Tab landing on any of these buttons already reveals the
                  row before it needs to be clicked.

                  Edit itself is gated three times, deliberately at three
                  different layers: `canEditComment` decides whether Edit
                  may be OFFERED at all (a permissions question);
                  `editPreviewsByCommentId` (from `prepareJiraCommentEdit`)
                  decides whether THIS comment's own content can be edited
                  without changing it (a losslessness question) — a comment
                  that fails it still gets an honest answer in this row
                  rather than Edit silently vanishing as though the feature
                  didn't exist for it; and the Edit button's own onClick
                  below re-checks, live, whether the comment has actually
                  changed since `c` (a freshness question) before it will
                  open an editor over it at all — see that handler's own
                  comment, and JiraCommentComposer.tsx's handlePost for the
                  second half of the same guard, immediately before Save.
                  Delete gets the same freshness re-check, immediately
                  before its own irreversible call — see
                  handleDeleteComment's own comment.

                  Reply does not: it posts a brand-new comment rather than
                  overwriting one, so a stale parent is a stale-looking
                  thread at worst, never lost content — see handlePost's own
                  comment in JiraCommentComposer.tsx for the full reasoning.

                  None of the three re-checks reads `ticket.hasConflict`,
                  and that is deliberate too, not an oversight matching the
                  pickers/attachment-upload gating elsewhere on this page.
                  That flag is this ticket's own cached `updated` timestamp
                  having moved for ANY reason — a priority change, a
                  relabel, someone else's comment on an entirely different
                  part of the thread — and the pickers gate on it only
                  because they have no finer-grained signal available at
                  all. Comments do: `updatedAt` on the one comment actually
                  being touched, re-read live at the moment it matters.
                  Gating comments on `hasConflict` too would only add false
                  positives on top of that real check — blocking Reply/Edit/
                  Delete over drift in a field no comment action even
                  reads — not add any safety a precise, per-comment,
                  live-verified check doesn't already provide. */}
              <div className="mt-1 flex items-center gap-2.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                {c.authorAccountId !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      // Reply targets the composer above the thread, never
                      // this comment's own spot — so any inline edit open
                      // elsewhere in the thread is abandoned rather than
                      // left open alongside a reply-in-progress.
                      setPendingEdit(null);
                      setPendingReply({
                        commentId: c.id,
                        accountId: c.authorAccountId as string,
                        displayName: c.authorName,
                      });
                    }}
                    className="rounded text-[10.5px] font-semibold text-text-muted hover:text-text hover:underline"
                  >
                    Reply
                  </button>
                )}
                {canEditComment(c) &&
                  (() => {
                    const editPreview =
                      editPreviewsByCommentId.get(c.id) ?? null;
                    if (editPreview) {
                      const checking = checkingEditId === c.id;
                      return (
                        <button
                          type="button"
                          disabled={checking}
                          ref={(el) => {
                            // Read by closeInlineEdit to return focus here
                            // once Cancel or a successful Save unmounts this
                            // comment's own inline editor — see that
                            // function's own comment.
                            if (el) editButtonRefs.current.set(c.id, el);
                            else editButtonRefs.current.delete(c.id);
                          }}
                          onClick={async () => {
                            // Edit targets this comment's own inline spot,
                            // never the composer above the thread — so any
                            // reply in progress there is abandoned here
                            // (editGeneration below remounts that composer
                            // to actually drop its own draft once the
                            // editor for THIS comment actually opens).
                            setPendingReply(null);
                            setCheckingEditId(c.id);
                            try {
                              // Live re-check before opening an editor over
                              // whatever `c` currently shows — found in
                              // review: comments load once when the ticket
                              // opens, and nothing before this re-verified
                              // them were still current by the time Edit was
                              // actually clicked, arbitrarily long after
                              // that load. `refreshAndFindComment` is the
                              // same freshness guard handleDeleteComment
                              // uses, for the same reason: `updatedAt` is the
                              // one signal this app already treats as "did
                              // this comment change" (see toComment's own
                              // comment on it), and it costs nothing extra
                              // to check it here, before committing to an
                              // editor, rather than only at Save.
                              const freshness = await refreshAndFindComment(
                                c.id,
                              );
                              if (freshness.status === 'unavailable') {
                                // A named 404 for this comment, not an
                                // inference from it being missing off a
                                // capped listJiraComments page — see
                                // CommentFreshness's own comment for why
                                // that used to be unusable evidence. A 404
                                // still doesn't prove a deletion (could be a
                                // permission change instead), so this can
                                // only say Jira won't show it, not that it
                                // was removed.
                                showErrorToast(
                                  "Jira won't show this comment any more — it was deleted, or you no longer have permission to see it. The thread above now shows the latest version.",
                                );
                                return;
                              }
                              const freshComment = freshness.comment;
                              if (
                                c.updatedAt !== null &&
                                freshComment.updatedAt !== null &&
                                freshComment.updatedAt !== c.updatedAt
                              ) {
                                showErrorToast(
                                  'This comment changed in Jira since you last saw it. The thread above now shows the latest version — click Edit again to edit it.',
                                );
                                return;
                              }
                              // Recomputed against the fresh read rather than
                              // reused from `editPreviewsByCommentId` above:
                              // that map was built from `c`, the copy on
                              // screen before this click, and the whole
                              // point of the re-check just above is that this
                              // fresh comment is the one actually safe to
                              // trust now — even though, when `updatedAt`
                              // matches as it just did, the two are the same
                              // content by this app's own definition of
                              // "changed" (see JiraWireComment.updatedAt).
                              const freshPreview =
                                prepareJiraCommentEdit(freshComment);
                              if (!freshPreview) {
                                showErrorToast(
                                  "Waypoint can't rebuild this comment's formatting without changing it, so editing it here is refused.",
                                );
                                return;
                              }
                              setEditGeneration((g) => g + 1);
                              setPendingEdit({
                                commentId: c.id,
                                updatedAt: freshComment.updatedAt,
                                ...freshPreview,
                              });
                            } finally {
                              setCheckingEditId(null);
                            }
                          }}
                          className="rounded text-[10.5px] font-semibold text-text-muted hover:text-text hover:underline disabled:opacity-60"
                        >
                          {checking ? 'Checking…' : 'Edit'}
                        </button>
                      );
                    }
                    // Refused, honestly — see this block's own header comment.
                    // Jira's `focusedCommentId` permalink is the one real path
                    // left to change this comment's content at all.
                    return jiraUrl ? (
                      <span
                        className="text-[10.5px] text-text-muted"
                        title="Waypoint can't rebuild this comment's formatting without changing it, so editing it here is refused rather than risking that."
                      >
                        Can&apos;t edit here ·{' '}
                        <a
                          href={buildJiraCommentPermalink(
                            connection?.site ?? '',
                            ticket.key,
                            c.id,
                          )}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-text-muted hover:text-text hover:underline"
                        >
                          Edit in Jira
                        </a>
                      </span>
                    ) : null;
                  })()}
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
            </>
          )}
        </div>
      </div>
    );
  }

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
          {/* Above the thread, not below it — matching Jira's own layout
              (verified live against ENG-84: "Add a comment…" sits directly
              under the Comments tab, above every existing comment, not
              after the last one). `key`s this composer to editGeneration so
              starting an Edit elsewhere (see renderComment's Edit handler)
              remounts it, abandoning whatever draft — a reply prefill or a
              plain typed comment — was in progress here; the same "loading
              an edit replaces the whole draft" behavior this composer had
              before Edit moved to its own inline spot, just triggered from
              outside now that the two are separate instances. No
              pendingEdit/onEditConsumed/onEdited here: this instance never
              edits anything, only posts new (possibly nested, via
              pendingReply) comments — see renderComment for the second
              instance that does edit, mounted per comment rather than once
              here. */}
          <JiraCommentComposer
            key={editGeneration}
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
          {/* Said before the thread, not after it: the whole failure this
              fixes is a reader finishing a partial thread believing it was
              the whole one. `total` comes from Jira rather than being
              inferred, so this can name the real number instead of hedging
              with "there are more". */}
          {commentTotal > comments.length && (
            <div className="mt-3 rounded-[var(--radius-sm)] border border-warning/30 bg-warning-bg px-3 py-2 text-[11.5px] leading-relaxed text-warning">
              Showing the {comments.length} most recent of {commentTotal}{' '}
              comments. Open this issue in Jira to read the rest.
            </div>
          )}
          <div className="mt-3 space-y-3.5">
            {/* Nested, not flat: Jira genuinely threads comments (verified
                live against ENG-84 — see JiraWireComment.parentId's own
                comment), so a reply now renders under the comment it
                answers instead of beside it. `groupCommentsIntoThreads`
                is what decides the grouping, and it decides it from
                `parentId` as JIRA REPORTED IT on each comment — never from
                which button the user clicked — so a reply Jira didn't
                actually nest (the write endpoint accepting `parentId` is
                unverified) renders flat here too, honestly. */}
            {groupCommentsIntoThreads(comments).map(({ root, replies }) => (
              <div key={root.id}>
                {renderComment(root)}
                {replies.length > 0 && (
                  <div className="mt-2 ml-7 space-y-3 border-l border-border pl-3">
                    {replies.map((reply) => renderComment(reply))}
                  </div>
                )}
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
