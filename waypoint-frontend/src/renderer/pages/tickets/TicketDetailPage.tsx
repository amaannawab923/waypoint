import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { clsx } from 'clsx';
import {
  Copy,
  GitMerge,
  Link as LinkIcon,
  Maximize2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Repeat,
  Link2,
  Reply as ReplyIcon,
  Ruler,
  SmilePlus,
  Tag,
  Trash2,
  UserPlus,
} from 'lucide-react';
import {
  IconCheck,
  IconChevron,
  IconChevronRight,
  IconLayers,
  IconPlus,
  IconX,
} from '@/components/icons';
import { Tooltip } from '@/components/ui/Tooltip';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import {
  AttachmentTray,
  type UploadItem,
} from '@/components/domain/AttachmentTray';
import { AttachmentList } from '@/components/domain/AttachmentList';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { useRecordRecent } from '@/lib/recents';
import {
  addComment,
  addTicketLink,
  createTicket,
  deleteComment,
  deleteTicket,
  editComment,
  getCurrentUser,
  getProject,
  getTicket,
  getTicketByIdentifier,
  listActivity,
  listAgentAssignments,
  listAgents,
  listComments,
  listSprints,
  listLabels,
  listMembers,
  listWorkstreams,
  listStates,
  listSubItems,
  listTicketProposals,
  removeTicketLink,
  takeBackOverFromAgent,
  toggleCommentReaction,
  uploadAttachment,
  deleteAttachment,
  toggleTicketAgent,
  toggleTicketAssignee,
  toggleTicketLabel,
  updateTicket,
  markNotificationsReadForTicket,
} from '@/data/api';
import { announceNotificationsChanged } from '@/lib/notificationEvents';
import type { Attachment, Comment, Ticket } from '@/types/entities';
import { renderMarkdown } from '@/lib/markdown';
import { groupCommentsIntoThreads } from '@/lib/commentThreads';
import { JIRA_COMMENT_EMOJI } from '@/components/domain/jiraCommentEmoji';
import { Avatar, AvatarStack } from '@/components/ui/Avatar';
import { Badge, Dot } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { DatePicker } from '@/components/ui/DatePicker';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { CopilotProposalCard } from '@/components/domain/CopilotProposalCard';
import { TicketRunsSection } from '@/components/sessions/TicketRunsSection';
import { CreateTicketModal } from '@/components/domain/CreateTicketModal';
import { agentLabel } from '@/lib/agentLabel';
import {
  AGENT_STATUS_CONFIG,
  AgentStatusBadge,
} from '@/components/domain/AgentStatusBadge';
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  PriorityIcon,
} from '@/components/domain/PriorityIcon';
import { StateIcon } from '@/components/domain/StateIcon';
import { TicketActivity } from '@/components/domain/activity/TicketActivity';
import { isDisclosedAgentHtml } from '@/lib/agentCommentHtml';
import {
  approveProposal,
  rejectProposal,
  upsertProposals,
  useAllProposals,
} from '@/lib/proposalStore';

/** One size for every comment action icon. The sidebar pass had to unpick
 *  four ad-hoc icon sizes chosen per call site; not starting that here. */
const COMMENT_ACTION_ICON = 14;

/** The filled, generously padded body a comment sits in. It is the reason
 *  a long thread reads as a conversation rather than a wall: the bubble
 *  edge is what separates one person's words from the next person's, so
 *  the author line above it doesn't have to. */
const COMMENT_BUBBLE =
  'rounded-[var(--radius)] border border-border bg-surface px-3.5 py-3 text-sm text-text-secondary';

/** A comment's actions are chips with an icon AND a word, always visible.
 *  Reply is a bordered pill reading "Reply" because an unlabelled icon
 *  that only appears on hover is exactly what made this thread's own
 *  threading undiscoverable twice over. */
const COMMENT_ACTION_CHIP =
  'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-xs text-text-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-text';

// Cap for the description textarea's auto-grow (finding 1) — past this it
// becomes a normal scrollable region (thin-scroll, the same capped-scroll
// utility every other bounded container in this app uses, e.g. TicketDrawer)
// instead of growing the page indefinitely.
const DESCRIPTION_MAX_HEIGHT = 400;

const TRIGGER_CLASS =
  'flex h-8 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-sm text-text hover:bg-surface-2';
const PANEL_CLASS =
  'thin-scroll max-h-64 w-56 overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg';
const OPTION_CLASS =
  'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2';

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
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  const diffYear = Math.round(diffMonth / 12);
  return `${diffYear}y ago`;
}

/**
 * "Sep 17 at 11:24 pm" — an absolute timestamp, and the
 * reason it beats the relative form for a comment specifically: a thread is
 * a record people cite later ("as of the 17th…"), and "2mo ago" forces the
 * reader to do arithmetic to get back to the date that was actually meant.
 * The relative form is still carried, in the `title`, for the one thing it
 * is better at — telling you at a glance that something just happened.
 */
function formatCommentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    // The year only when it isn't this one — a thread is almost always
    // read in the year it was written, and "Sep 17, 2026 at…" spends
    // width on a fact the reader already has.
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A composer's submit label: waiting on uploads beats everything, since
 *  the button is disabled for exactly that reason and should say so. */
function submitLabel(
  uploading: boolean,
  busy: boolean,
  busyLabel: string,
  idleLabel: string,
): string {
  if (uploading) return 'Uploading…';
  if (busy) return busyLabel;
  return idleLabel;
}

/**
 * Asks before throwing away something the person wrote or uploaded.
 *
 * Escape and Cancel both route here, and both used to discard silently: a
 * paragraph lost to one stray keystroke, on a surface whose threads are the
 * record people cite later (review finding). Nothing to lose means no
 * question, so an empty box still closes instantly.
 */
function confirmDiscard(draft: string, uploadCount: number): boolean {
  if (draft.trim() === '' && uploadCount === 0) return true;
  // eslint-disable-next-line no-alert
  return window.confirm(
    uploadCount > 0
      ? 'Discard this comment and its attachments?'
      : 'Discard this comment?',
  );
}

/**
 * One composer's in-flight and finished uploads.
 *
 * Deliberately a hook with no arguments, instantiated once per composer
 * (top box, reply box, inline edit) rather than one shared store keyed by
 * target: three unconditional calls can never violate the rules of hooks,
 * and a file dropped on the reply box must not appear in the top box's
 * tray. The ticket id is passed per call instead of captured, so a hook
 * instance survives the ticket changing underneath it.
 *
 * An upload starts the instant a file arrives, before anything is posted —
 * that is what lets someone see the size, the thumbnail and the progress
 * and then decide. If they discard the draft instead, the finished files
 * are deleted (discard below), and anything left behind by a window closed
 * mid-draft is swept by the server after a day.
 */
function useCommentUploads() {
  const [items, setItems] = useState<UploadItem[]>([]);
  // Keyed by the same `key` the items carry, so Remove can abort a request
  // that is still in flight rather than only hiding its row.
  const controllers = useRef(new Map<string, AbortController>());

  const patch = (key: string, next: Partial<UploadItem>) =>
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...next } : x)));

  async function send(ticketId: string, key: string, file: File) {
    const controller = new AbortController();
    controllers.current.set(key, controller);
    patch(key, { status: 'uploading', progress: 0, error: undefined });
    try {
      const attachment = await uploadAttachment(ticketId, file, {
        onProgress: (fraction) => patch(key, { progress: fraction }),
        signal: controller.signal,
      });
      patch(key, { status: 'done', progress: 1, attachment });
    } catch (err) {
      // An abort is the person's own doing — it gets its own status, not
      // an error row telling them something went wrong.
      patch(key, {
        status: (err as Error)?.name === 'AbortError' ? 'aborted' : 'error',
        error:
          (err as Error)?.name === 'AbortError'
            ? undefined
            : ((err as Error)?.message ?? 'Upload failed.'),
      });
    } finally {
      controllers.current.delete(key);
    }
  }

  function addFiles(ticketId: string, files: File[]) {
    files.forEach((file, i) => {
      const key = `${Date.now()}-${i}-${file.name}`;
      setItems((xs) => [
        ...xs,
        { key, file, progress: 0, status: 'uploading' as const },
      ]);
      void send(ticketId, key, file);
    });
  }

  function retry(ticketId: string, key: string) {
    const item = items.find((x) => x.key === key);
    if (item) void send(ticketId, key, item.file);
  }

  /** Aborts if still uploading, and deletes server-side if it already
   *  finished — a removed row must not leave a file claimable later. */
  function remove(key: string) {
    controllers.current.get(key)?.abort();
    const item = items.find((x) => x.key === key);
    if (item?.attachment) void deleteAttachment(item.attachment.id);
    setItems((xs) => xs.filter((x) => x.key !== key));
  }

  /** The ids a post should claim: only the uploads that actually finished. */
  const uploadedIds = items
    .filter((x) => x.status === 'done' && x.attachment)
    .map((x) => (x.attachment as Attachment).id);

  /** True while any file is still on its way up. Posting in that window
   *  used to go ahead with only the finished files, then abort the rest, so
   *  the comment appeared without a file the person could see uploading. */
  const uploading = items.some((x) => x.status === 'uploading');

  /** After a successful post. Every finished file now belongs to the
   *  comment, so there is nothing to delete, only the tray to empty. */
  function clearAfterPost() {
    controllers.current.forEach((c) => c.abort());
    controllers.current.clear();
    setItems([]);
  }

  /** When the person throws the draft away. Aborts anything still
   *  uploading and DELETES every file that already finished. No screen
   *  lists unclaimed files, so keeping them would mean stored and counted,
   *  but invisible. (It used to keep them, while the confirm dialog said
   *  they were being discarded.) A file whose upload completes on the
   *  server in the instant before its abort lands is caught by the
   *  server's own sweep of abandoned drafts. */
  function discard() {
    controllers.current.forEach((c) => c.abort());
    controllers.current.clear();
    items.forEach((x) => {
      if (x.attachment) void deleteAttachment(x.attachment.id);
    });
    setItems([]);
  }

  return { items, addFiles, retry, remove, uploadedIds, uploading, clearAfterPost, discard };
}

/** Small self-contained popover: caller renders the trigger and the panel content. */
function Dropdown({
  trigger,
  children,
  align = 'left',
}: {
  trigger: (toggle: () => void, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div
          className={clsx(
            'absolute z-30 mt-1',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** ROAD-162: the reaction picker's panel content, reusing
 * jiraCommentEmoji.ts's ~90-entry curated list (built for Jira's comment
 * composer's own emoji-insert picker) rather than adding a dependency or a
 * second list — see that file's own comment. A separate component, not
 * state inline in `Dropdown`'s children function, purely so `query` resets
 * to empty every time the picker is reopened instead of remembering the
 * last search across opens (Dropdown unmounts its children on close). */
function EmojiPickerPanel({ onSelect }: { onSelect: (char: string) => void }) {
  const [query, setQuery] = useState('');
  const filtered = query.trim()
    ? JIRA_COMMENT_EMOJI.filter((e) =>
        e.name.includes(query.trim().toLowerCase()),
      )
    : JIRA_COMMENT_EMOJI;

  return (
    <div className="w-64 overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface shadow-lg">
      <div className="border-b border-border p-2">
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji…"
          aria-label="Search emoji"
          className="w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg-inset px-2 py-1.5 text-[12.5px] text-text outline-none focus:border-accent"
        />
      </div>
      <div className="thin-scroll grid max-h-[190px] grid-cols-7 gap-0.5 overflow-y-auto p-1.5">
        {filtered.map((emoji) => (
          <button
            key={emoji.char}
            type="button"
            title={emoji.name}
            aria-label={emoji.name}
            onClick={() => onSelect(emoji.char)}
            className="flex size-8 items-center justify-center rounded text-[15px] hover:bg-surface-2"
          >
            {emoji.char}
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="col-span-7 px-1 py-3 text-center text-xs text-text-muted">
            No matches.
          </div>
        )}
      </div>
    </div>
  );
}

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

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(OPTION_CLASS, danger && 'text-danger hover:bg-danger-bg')}
    >
      {icon}
      {label}
    </button>
  );
}

/** Small popover form used by the "Add link" action: URL + optional label. */
function AddLinkForm({
  onAdd,
  onCancel,
}: {
  onAdd: (url: string, label: string) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');

  function submit() {
    const trimmed = url.trim();
    if (!trimmed) return;
    const normalized = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    onAdd(normalized, label.trim() || normalized);
  }

  return (
    <div className="flex w-72 flex-col gap-2 rounded-[var(--radius-sm)] border border-border bg-surface p-3 shadow-lg">
      <input
        autoFocus
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        className="h-8 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2 text-sm text-text outline-none focus:border-accent"
      />
      <input
        placeholder="Label (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        className="h-8 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2 text-sm text-text outline-none focus:border-accent"
      />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!url.trim()}
          onClick={submit}
        >
          Add link
        </Button>
      </div>
    </div>
  );
}

export function TicketDetailContent({
  projectId,
  identifier,
  variant = 'page',
  onClose,
  onExpand,
  autoAssignAgentId,
  onAutoAssigned,
}: {
  projectId: string;
  identifier: string;
  variant?: 'page' | 'drawer';
  onClose?: () => void;
  onExpand?: () => void;
  /** Set when arriving back from "+ Create new agent" — the newly created agent gets
   * assigned to this ticket automatically, completing the "create inline, land back
   * where you were" round trip instead of leaving the user to re-open the dropdown. */
  autoAssignAgentId?: string;
  onAutoAssigned?: () => void;
}) {
  // useProject() is `useOutletContext<ProjectOutletContext>()` under the
  // hood — it does NOT throw when there's no ambient outlet context, it
  // just returns undefined. This page is reachable from routes that never
  // provide that context at all: AllTicketsPage's peek drawer (`/views`)
  // isn't nested under <ProjectLayout>, and each row there can belong to a
  // DIFFERENT project anyway, so even a route that DID provide a project
  // wouldn't necessarily be the right one for the ticket being viewed.
  // Never destructure this directly — `const { project } = useProject()`
  // throws a TypeError the instant `useProject()` returns undefined, which
  // previously took the entire app down to a white screen (there was no
  // ErrorBoundary yet either — see router.tsx). Resolve the actual project
  // this ticket belongs to further down, from the ticket's own projectId.
  const projectOutletContext = useProject();
  const navigate = useNavigate();
  const isDrawer = variant === 'drawer';

  const {
    data: item,
    loading: itemLoading,
    reload: reloadItem,
  } = useAsync(() => getTicketByIdentifier(identifier), [identifier]);

  // `item` loads asynchronously — on the very first render, before it
  // resolves, itemProjectId is '' and these would otherwise fire against
  // /projects//workstreams etc. (a malformed path segment, 404) a beat before
  // immediately re-firing correctly once the real id arrives. Skip the
  // fetch entirely while there's no real id yet, same end state, no
  // spurious failed request or error toast along the way.
  const itemProjectId = item?.projectId ?? '';

  // The outlet-provided project is only trustworthy when it's actually
  // FOR this ticket — true on every normal /projects/:projectId/tickets/:id
  // route, but never true on the All Tickets peek drawer (no context at
  // all) and not guaranteed anywhere a ticket from one project could be
  // rendered while a different project's route context happens to be
  // mounted. When it doesn't match, fetch this ticket's own project
  // directly instead of assuming one.
  const contextProject =
    projectOutletContext && projectOutletContext.project.id === itemProjectId
      ? projectOutletContext.project
      : undefined;
  const needsProjectFetch = !contextProject && itemProjectId !== '';
  const { data: fetchedProject, loading: projectFetchLoading } = useAsync(
    () =>
      needsProjectFetch
        ? getProject(itemProjectId)
        : Promise.resolve(undefined),
    [needsProjectFetch, itemProjectId],
  );
  const project = contextProject ?? fetchedProject;
  const { data: states } = useAsync(
    () => (itemProjectId ? listStates(itemProjectId) : Promise.resolve([])),
    [itemProjectId],
  );
  const { data: labels } = useAsync(
    () => (itemProjectId ? listLabels(itemProjectId) : Promise.resolve([])),
    [itemProjectId],
  );
  const { data: workstreams } = useAsync(
    () =>
      itemProjectId ? listWorkstreams(itemProjectId) : Promise.resolve([]),
    [itemProjectId],
  );
  const { data: sprints } = useAsync(
    () => (itemProjectId ? listSprints(itemProjectId) : Promise.resolve([])),
    [itemProjectId],
  );
  const { data: allMembers } = useAsync(() => listMembers(), []);
  const { data: currentUser } = useAsync(() => getCurrentUser(), []);
  const { data: agents } = useAsync(() => listAgents(), []);
  const { data: allAgentAssignments, reload: reloadAgentAssignments } =
    useAsync(() => listAgentAssignments(), []);

  const { data: subItems, reload: reloadSubItems } = useAsync(
    () => (item ? listSubItems(item.id) : Promise.resolve([])),
    [item?.id],
  );
  const { data: activity, reload: reloadActivity } = useAsync(
    () => (item ? listActivity(item.id) : Promise.resolve([])),
    [item?.id],
  );
  const {
    data: comments,
    loading: commentsLoading,
    error: commentsError,
    reload: reloadComments,
    setData: setComments,
  } = useAsync(
    () => (item ? listComments(item.id) : Promise.resolve([])),
    [item?.id],
  );
  const { data: parentItem } = useAsync(
    () =>
      item?.parentId ? getTicket(item.parentId) : Promise.resolve(undefined),
    [item?.parentId],
  );

  // Pending proposals (W4.4, architecture §4.4) — fetched into the shared
  // proposalStore rather than kept as page-local state, so approving here
  // updates the same underlying row a future Review screen or the Copilot
  // panel would also see, with no refetch anywhere. Only ever fetches
  // status='proposed' rows; a resolved one lingers in the store (and this
  // section) just long enough to show its resolution note, same as the
  // Copilot panel — see lib/useCopilotProposals.ts.
  const { data: fetchedTicketProposals } = useAsync(
    () =>
      item ? listTicketProposals(item.id, 'proposed') : Promise.resolve([]),
    [item?.id],
  );
  useEffect(() => {
    if (fetchedTicketProposals) upsertProposals(fetchedTicketProposals);
  }, [fetchedTicketProposals]);
  const allProposals = useAllProposals();
  const ticketProposals = useMemo(
    () => (item ? allProposals.filter((p) => p.ticketId === item.id) : []),
    [allProposals, item?.id],
  );

  // Reloads this ticket's own item/activity/comments whenever one of ITS
  // proposals resolves to 'executed' — from ANY surface, not just this
  // page's own inline "Pending proposals" card. proposalStore only tracks a
  // proposal row's own status; approving one is just one more way this
  // ticket's fields can change server-side (patchItem, toggleAssignee, ...
  // above already reload after every other such mutation), and every
  // approve/reject in the app — this card, CopilotPanel.tsx's chat-panel
  // card, a future Review queue — already goes through the SAME shared
  // proposalStore.approveProposal/rejectProposal, whose upsert already
  // broadcasts to every `useAllProposals()` subscriber (this component
  // included, via `allProposals` above). Reacting to that existing
  // broadcast here — instead of requiring every approval call site to
  // remember its own reload — is what makes this correct regardless of
  // which surface triggered the approve: CopilotPanel.tsx's own card calls
  // `proposalStore.approve` directly and previously left this page's
  // sidebar (e.g. Priority) stale until a full reload, because that path
  // never touched this page's local reload logic at all.
  const seenExecutedProposalIdsRef = useRef<Set<string>>(new Set());
  const isFirstProposalCheckRef = useRef(true);
  useEffect(() => {
    // Skip the mount render: `item` (fetched fresh via getTicketByIdentifier
    // above) is already current as of mount, and any proposal that shows as
    // already-'executed' on first paint was resolved before this page even
    // opened — nothing to react to, just a starting snapshot to seed
    // against so a LATER transition can be told apart from one that was
    // already resolved when this page mounted.
    if (isFirstProposalCheckRef.current) {
      isFirstProposalCheckRef.current = false;
      for (const p of ticketProposals) {
        if (p.status === 'executed')
          seenExecutedProposalIdsRef.current.add(p.id);
      }
      return;
    }
    let shouldReload = false;
    for (const p of ticketProposals) {
      if (
        p.status === 'executed' &&
        !seenExecutedProposalIdsRef.current.has(p.id)
      ) {
        seenExecutedProposalIdsRef.current.add(p.id);
        shouldReload = true;
      }
    }
    if (shouldReload) {
      reloadItem();
      reloadActivity();
      reloadComments();
    }
  }, [ticketProposals, reloadItem, reloadActivity, reloadComments]);

  // A `#comment-<id>` hash (from handleCopyCommentLink below) scrolls that
  // comment into view and flashes it, once the thread it names has actually
  // loaded — hence the dependency on `comments` rather than a bare mount
  // effect, which would run while the list is still undefined and find
  // nothing. `hash` is in the deps so pasting the SAME link twice during
  // one visit still re-flashes.
  //
  // React state, not a `data-` attribute toggled on the node: the attribute
  // version needed an arbitrary `data-[…]:` Tailwind variant, and that
  // class was verified live never to be generated — the flash silently did
  // nothing. A plain conditional class costs one render of a thread that is
  // already re-rendering, and cannot fail that way.
  const { hash } = useLocation();
  const [flashedCommentId, setFlashedCommentId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Scroll to a comment and flash it. Activity's quotes call this directly
  // rather than routing to the #comment- hash: in the drawer, routing would
  // drop `?peek=` and close it, and a second click on the same quote would
  // not change the hash, so nothing would happen.
  const jumpToComment = useCallback((id: string) => {
    document
      .getElementById(`comment-${id}`)
      ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    setFlashedCommentId(id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashedCommentId(null), 1600);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  // Once per hash: a later comments reload (a reaction, a reply) must not
  // pull the page back to a link the reader arrived on long ago.
  const handledHash = useRef<string | null>(null);
  useEffect(() => {
    if (!hash.startsWith('#comment-') || !comments?.length) return;
    if (handledHash.current === hash) return;
    handledHash.current = hash;
    jumpToComment(hash.slice('#comment-'.length));
  }, [hash, comments, jumpToComment]);

  useRecordRecent(
    item
      ? {
          type: 'ticket',
          id: item.id,
          title: `${item.identifier} ${item.title}`,
          projectId: item.projectId,
          path: `/projects/${item.projectId}/tickets/${item.identifier}`,
        }
      : null,
  );

  const [titleDraft, setTitleDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  // B2: local draft state for Story points, matching titleDraft/descDraft's
  // own shape — a string (not a number) so an in-progress "17." is
  // representable at all. The field used to be a controlled input bound
  // straight to `item.estimatePoints`, saving via patchItem() on every
  // keystroke; patchItem awaits updateTicket() then reloads the item, and
  // that reload landed mid-keystroke, so typing "17.5" got overwritten by
  // the reloaded `17` (Number("17.") === 17) before "5" could ever be
  // typed — the decimal point was unreachable. Draft-plus-blur, same as the
  // title/description fields below, fixes that.
  const [pointsDraft, setPointsDraft] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [createSubOpen, setCreateSubOpen] = useState(false);
  // Stable focus target for handlePostComment below — see its own comment.
  const commentFormRef = useRef<HTMLDivElement>(null);
  // ROAD-162 (second pass): the comment an INLINE reply box is open under,
  // rendered at the foot of that comment's own thread. The first pass
  // pointed Reply at the single shared composer below the entire thread,
  // which is what made threading unusable in practice: the box you were
  // sent to could be several screens away from the comment you clicked, so
  // clicking Reply looked like it did nothing. One level deep
  // (groupCommentsIntoThreads); at most one reply box open at a time.
  const [replyTarget, setReplyTarget] = useState<{
    commentId: string;
    authorName: string;
  } | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [postingReply, setPostingReply] = useState(false);
  // The top composer starts collapsed to a single "Leave a comment…" line
  // and grows on click, the way Jira's does — a permanently-open 3-row
  // textarea now that it sits at the TOP would push the first comment down
  // on every ticket, including the ones nobody is about to comment on.
  const [composerOpen, setComposerOpen] = useState(false);
  // Newest first by default, because the composer sits at the top: with
  // oldest first under a top composer, the comment you just posted lands
  // off the bottom of the screen. Toggleable, as Jira's own thread is.
  const [newestFirst, setNewestFirst] = useState(true);
  // Which comment currently has its own inline editor mounted in place of
  // its body — mutually exclusive with replyTarget (starting one clears the
  // other, matching JiraTicketDetail.tsx's same-shaped pendingEdit/
  // pendingReply split) and with itself (at most one comment is ever being
  // edited at a time).
  const [editingComment, setEditingComment] = useState<{
    commentId: string;
    draft: string;
  } | null>(null);
  // Which comment's permalink was just copied, so its own icon can
  // acknowledge it for a beat. Mirrors JiraTicketDetail.tsx's
  // copiedCommentId — same affordance, same 1.5s, so the two comment
  // surfaces behave identically.
  const [copiedCommentId, setCopiedCommentId] = useState<string | null>(null);
  // One per composer — see useCommentUploads for why three instances
  // rather than one keyed store.
  const headerFileInputRef = useRef<HTMLInputElement>(null);
  const composerUploads = useCommentUploads();
  const replyUploads = useCommentUploads();
  const editUploads = useCommentUploads();
  const [savingCommentEdit, setSavingCommentEdit] = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  // Finding 1: the description field used to be a fixed rows={4} textarea
  // that silently clipped anything past 4 lines, with only a manual
  // resize-y drag handle (easy to miss) as the way out. This measures the
  // element's own scrollHeight and grows it to fit on mount and on every
  // content change, capped at DESCRIPTION_MAX_HEIGHT — past that the
  // textarea itself scrolls (see its className below) instead of growing
  // forever.
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (item) {
      setTitleDraft(item.title);
      setDescDraft(item.description);
      setPointsDraft(
        item.estimatePoints === null ? '' : String(item.estimatePoints),
      );
    }
    // Only reset drafts when a *different* item loads, not on every reload after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  // Opening a ticket clears what its notifications were about (mentions,
  // replies, comments, assignment); the bell hears about it only when
  // something was actually cleared. Best effort: a failure changes nothing.
  useEffect(() => {
    if (!item?.id) return;
    const ticketId = item.id;
    // Started inside the promise so even a synchronous throw lands in the
    // catch below: clearing notifications must never break opening a ticket.
    Promise.resolve()
      .then(() => markNotificationsReadForTicket(ticketId))
      .then((updated) => {
        if (updated > 0) announceNotificationsChanged();
      })
      .catch(() => {});
  }, [item?.id]);

  useLayoutEffect(() => {
    const el = descTextareaRef.current;
    if (!el) return;
    // Reset to 'auto' first so scrollHeight reports the content's real
    // height rather than whatever height was previously forced — otherwise
    // deleting text would never shrink the textarea back down.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, DESCRIPTION_MAX_HEIGHT)}px`;
  }, [descDraft]);

  // Completes the "+ Create new agent" round trip: land back on this ticket
  // with the newly created agent auto-assigned, instead of leaving the user
  // to re-open the Assignees dropdown and pick it manually.
  useEffect(() => {
    if (!item || !autoAssignAgentId) return;
    if (item.assigneeIds.includes(autoAssignAgentId)) {
      onAutoAssigned?.();
      return;
    }
    let cancelled = false;
    (async () => {
      await toggleTicketAgent(item.id, autoAssignAgentId);
      if (cancelled) return;
      reloadItem();
      reloadActivity();
      reloadAgentAssignments();
      onAutoAssigned?.();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, autoAssignAgentId]);

  const membersById = useMemo(
    () => new Map((allMembers ?? []).map((m) => [m.id, m])),
    [allMembers],
  );
  const agentsById = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a])),
    [agents],
  );
  const statesById = useMemo(
    () => new Map((states ?? []).map((s) => [s.id, s])),
    [states],
  );
  // `project` can still be undefined here — these memos run on every render,
  // including the ones before stillLoadingCritical/the `!project` guard
  // below have had a chance to bail out (React hooks must run
  // unconditionally, so nothing above this point can be gated on `project`
  // being resolved yet).
  const projectMembers = useMemo(
    () =>
      project
        ? (allMembers ?? []).filter((m) => project.memberIds.includes(m.id))
        : [],
    [allMembers, project],
  );
  // Agents are scoped to a project the same way project membership scopes
  // humans: workspace-wide agents (scopeProjectIds: []) plus any explicitly
  // scoped to this project.
  const projectAgents = useMemo(
    () =>
      project
        ? (agents ?? []).filter(
            (a) =>
              a.isActive &&
              (a.scopeProjectIds.length === 0 ||
                a.scopeProjectIds.includes(project.id)),
          )
        : [],
    [agents, project],
  );

  // An assignee id (or activity/comment author id) may resolve against a
  // human member or an agent — both live in the same id space. Centralizing
  // this here means the Activity feed, Comments feed, and assignee avatar
  // stack all agree on how to render "who did this" without branching logic
  // duplicated three times.
  function resolveActor(id: string): {
    name: string;
    color: string;
    shape: 'circle' | 'square';
    model?: string;
  } {
    const member = membersById.get(id);
    if (member)
      return {
        name: member.displayName,
        color: member.avatarColor,
        shape: 'circle',
      };
    const agent = agentsById.get(id);
    if (agent)
      return {
        name: agent.name,
        color: agent.avatarColor,
        shape: 'square',
        model: agent.model,
      };
    return { name: 'Unknown', color: 'var(--accent)', shape: 'circle' };
  }

  // States and Activity are separate, independently-delayed fetches from the
  // item itself. Only gating the skeleton on `itemLoading` let the "loaded"
  // UI render as soon as the item resolved, while states/activity could
  // still be in flight — showing a brief "No state" / "No activity yet"
  // flash instead of the skeleton. Wait for those two (the ones the header
  // and Activity section directly depend on) before considering this loaded.
  // Also waits on the project resolving (see contextProject/fetchedProject
  // above) — everything below this point assumes `project` is defined.
  const stillLoadingCritical =
    (itemLoading && !item) ||
    Boolean(
      item &&
      (states === undefined ||
        activity === undefined ||
        (needsProjectFetch && projectFetchLoading)),
    );

  if (stillLoadingCritical) {
    const sidebarLabels = [
      'State',
      'Assignees',
      'Priority',
      'Story points',
      ...(project?.estimate ? ['Estimate'] : []),
      'Created by',
      'Start date',
      'Due date',
      'Workstreams',
      'Sprint',
      'Parent',
      'Labels',
    ];
    const sidebarWidths = ['7rem', '9rem', '6rem', '5rem', '8rem'];
    return (
      <div
        className={
          isDrawer
            ? 'flex h-full flex-col overflow-y-auto'
            : 'mx-auto flex max-w-[1400px] flex-col md:flex-row'
        }
      >
        <Skeleton
          className={clsx(
            'min-w-0 flex-1',
            !isDrawer && 'md:border-r md:border-border',
          )}
        >
          {/* Breadcrumb */}
          <div className="flex items-center justify-between border-b border-border px-6 py-3 md:px-8">
            <Skeleton.Block height="0.8rem" width="12rem" />
            <Skeleton.Circle size="1.5rem" />
          </div>

          {/* Title */}
          <div className="px-6 pt-5 md:px-8">
            <Skeleton.Block height="1.5rem" width="65%" />
          </div>

          {/* Description */}
          <div className="mt-4 space-y-2 px-6 md:px-8">
            <Skeleton.Block height="0.75rem" width="95%" />
            <Skeleton.Block height="0.75rem" width="88%" />
            <Skeleton.Block height="0.75rem" width="55%" />
          </div>

          {/* Action row */}
          <div className="mt-5 flex flex-wrap items-center gap-2 px-6 md:px-8">
            <Skeleton.Block
              height="2rem"
              width="9.5rem"
              rounded="rounded-[var(--radius-sm)]"
            />
            <Skeleton.Block
              height="2rem"
              width="7rem"
              rounded="rounded-[var(--radius-sm)]"
            />
            <Skeleton.Block
              height="2rem"
              width="6rem"
              rounded="rounded-[var(--radius-sm)]"
            />
          </div>

          {/* Activity */}
          <div className="mt-8 px-6 md:px-8">
            <Skeleton.Block height="0.75rem" width="4.5rem" className="mb-3" />
            <div className="space-y-3">
              {sidebarWidths.map((width, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Skeleton.Circle size="1.375rem" />
                  <Skeleton.Block height="0.75rem" width={width} />
                </div>
              ))}
            </div>
          </div>
        </Skeleton>

        {/* Properties panel */}
        <Skeleton
          className={clsx(
            'w-full shrink-0 border-t border-border px-6 py-5',
            !isDrawer &&
              'md:w-[300px] md:self-start md:border-t-0 md:px-5 md:py-6',
          )}
        >
          {sidebarLabels.map((label, index) => (
            <div key={label} className="flex items-center gap-3 py-2">
              <span className="w-[104px] shrink-0 text-xs text-text-muted">
                {label}
              </span>
              <Skeleton.Block
                height="1.25rem"
                width={sidebarWidths[index % sidebarWidths.length]}
                rounded="rounded-[var(--radius-sm)]"
              />
            </div>
          ))}
        </Skeleton>
      </div>
    );
  }

  if (!item) {
    return (
      <EmptyState
        title="Ticket not found"
        description={`We couldn't find a ticket with identifier "${identifier}".`}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              onClose?.();
              navigate(`/projects/${projectId}/tickets`);
            }}
          >
            Back to tickets
          </Button>
        }
      />
    );
  }

  // The ticket resolved but its own project didn't — either the fetch
  // above genuinely failed to find it (deleted/archived project, matching
  // ProjectLayout's own not-found copy) or, on a route that DOES provide
  // outlet context, that context is for some other project than this
  // ticket's own. Everything below assumes `project` is defined.
  if (!project) {
    return (
      <EmptyState
        title="Project not found"
        description="This ticket's project may have been deleted or archived."
      />
    );
  }

  const currentState = statesById.get(item.stateId);
  const currentWorkstream = (workstreams ?? []).find(
    (m) => m.id === item.workstreamId,
  );
  const currentSprint = (sprints ?? []).find((c) => c.id === item.sprintId);
  const creator = membersById.get(item.createdById);
  const assignedActors = item.assigneeIds
    .map((id) =>
      membersById.has(id) || agentsById.has(id) ? resolveActor(id) : null,
    )
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  const itemAgentAssignments = (allAgentAssignments ?? []).filter(
    (a) => a.ticketId === item.id && item.assigneeIds.includes(a.agentId),
  );
  const itemLabels = (labels ?? []).filter((l) => item.labelIds.includes(l.id));
  const itemLinks = item.links ?? [];
  const estimateSystem = project.estimate;
  const subItemsList = subItems ?? [];
  const doneSubItems = subItemsList.filter(
    (c) => statesById.get(c.stateId)?.group === 'completed',
  ).length;
  const subItemsProgress =
    subItemsList.length > 0
      ? Math.round((doneSubItems / subItemsList.length) * 100)
      : 0;
  // Finding 7c: sum of estimatePoints across this ticket's own subItems —
  // already fetched for the list below, no new request. Only shown when at
  // least one subtask actually carries a point value, so a plain checklist
  // of unestimated subtasks doesn't grow a misleading "· 0 pts" suffix.
  const subItemsWithPoints = subItemsList.filter(
    (c) => c.estimatePoints !== null,
  );
  const subItemsPointsTotal = subItemsWithPoints.reduce(
    (sum, c) => sum + (c.estimatePoints ?? 0),
    0,
  );

  async function patchItem(patch: Partial<Ticket>) {
    if (!item) return;
    await updateTicket(item.id, patch);
    reloadItem();
    reloadActivity();
  }

  async function toggleAssignee(memberId: string) {
    if (!item) return;
    // Toggles against the current persisted assigneeIds server-side (see
    // toggleTicketAssignee) rather than computing the next array from this
    // component's possibly-stale `item` state, so two toggles fired in quick
    // succession can't race and silently revert each other.
    await toggleTicketAssignee(item.id, memberId);
    reloadItem();
    reloadActivity();
  }

  // A single toggle click, same as toggleAssignee — but removing an already-
  // assigned agent reads as a hand-off rather than a bare unassign, so it
  // goes through takeBackOverFromAgent (closes the run record, posts a
  // system comment) instead of the generic toggle.
  async function toggleAgent(agentId: string) {
    if (!item) return;
    if (item.assigneeIds.includes(agentId)) {
      await takeBackOverFromAgent(item.id, agentId);
      reloadComments();
    } else {
      await toggleTicketAgent(item.id, agentId);
    }
    reloadItem();
    reloadActivity();
    reloadAgentAssignments();
  }

  async function toggleLabel(labelId: string) {
    if (!item) return;
    await toggleTicketLabel(item.id, labelId);
    reloadItem();
    reloadActivity();
  }

  async function saveTitle() {
    if (!item) return;
    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setTitleDraft(item.title);
      return;
    }
    if (trimmed === item.title) return;
    await updateTicket(item.id, { title: trimmed });
    reloadItem();
    reloadActivity();
  }

  async function saveDescription() {
    if (!item) return;
    if (descDraft === item.description) return;
    await updateTicket(item.id, { description: descDraft });
    reloadItem();
    reloadActivity();
  }

  // B2: commits the Story points draft on blur, same shape as saveTitle/
  // saveDescription above. An empty draft clears the field back to null,
  // matching the field's pre-existing clear-on-empty behavior; anything
  // that doesn't parse to a finite number (e.g. a draft left mid-edit as
  // just "-" or ".") is treated the same way saveTitle treats an
  // all-whitespace title — reverted to the last saved value instead of
  // persisted.
  //
  // M5: a negative value (e.g. typed "-5") is rejected the same way — the
  // input's `min="0"` only constrains the stepper arrows/native form
  // validation, not a typed keyboard value flowing through this blur-save
  // handler, so a negative number parsed here as perfectly finite and was
  // persisted via updateTicket without this explicit check.
  async function savePoints() {
    if (!item) return;
    const trimmed = pointsDraft.trim();
    if (trimmed === '') {
      if (item.estimatePoints === null) return;
      await updateTicket(item.id, { estimatePoints: null });
      reloadItem();
      reloadActivity();
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setPointsDraft(
        item.estimatePoints === null ? '' : String(item.estimatePoints),
      );
      return;
    }
    if (parsed === item.estimatePoints) return;
    await updateTicket(item.id, { estimatePoints: parsed });
    reloadItem();
    reloadActivity();
  }

  // The new ticket is created with parentId already set (via
  // CreateTicketModal's defaultParentId prop below) — no follow-up PATCH
  // needed here anymore, unlike the create-then-updateTicket workaround
  // this used to be.
  function handleSubItemCreated() {
    reloadSubItems();
  }

  async function handleAddLink(url: string, label: string) {
    if (!item) return;
    await addTicketLink(item.id, { url, label });
    reloadItem();
  }

  async function handleRemoveLink(linkId: string) {
    if (!item) return;
    await removeTicketLink(item.id, linkId);
    reloadItem();
  }

  async function handlePostComment() {
    // Text or files, at least one; never while a file is still uploading.
    // The button is disabled in both cases too, but ⌘↵ reaches here
    // without it.
    if (
      !item ||
      (!commentDraft.trim() && composerUploads.uploadedIds.length === 0) ||
      composerUploads.uploading ||
      postingComment
    ) {
      return;
    }
    // Same focus-blur/keystroke-leak issue the Copilot composer had (see
    // CopilotPanel.tsx's Composer): this button goes `disabled={...||
    // postingComment}` right below, and the HTML spec force-blurs a
    // focused control the instant `disabled` is applied — moving the next
    // keystroke to global shortcuts (e.g. Tab to this button, Enter to
    // post, then "g" navigating away instead of doing nothing). Buttons
    // have no readOnly equivalent, so land focus on the comment form's own
    // stable container (commentFormRef, never disabled or unmounted by
    // this) before disabling, instead of letting it fall through to
    // <body>.
    commentFormRef.current?.focus();
    setPostingComment(true);
    try {
      // Always top-level: a reply posts from its own inline box
      // (handlePostReply below), which is the only thing that carries a
      // parentId now.
      await addComment(
        item.id,
        commentDraft.trim(),
        null,
        composerUploads.uploadedIds,
      );
      setCommentDraft('');
      setComposerOpen(false);
      composerUploads.clearAfterPost();
      reloadComments();
      reloadActivity();
    } finally {
      setPostingComment(false);
    }
  }

  /** Opens a reply box inline, at the foot of the thread this comment
   * belongs to — never the shared composer at the top, which posts
   * top-level comments only. Any edit open elsewhere in the thread is
   * abandoned rather than left open alongside a reply-in-progress (mirrors
   * JiraTicketDetail.tsx's Reply handler); the draft is cleared so a reply
   * started under one comment can't be posted under another. */
  function handleReplyClick(comment: Comment) {
    // Opening a reply closes whatever else was being written: an edit, or a
    // reply under a different comment. That used to happen silently, taking
    // any typed text and uploaded files with it. Now it asks first, and
    // only when there is something to lose.
    if (!confirmAbandonOtherDrafts({ keepReplyTo: comment.id })) return;
    setEditingComment(null);
    editUploads.discard();
    if (replyTarget?.commentId !== comment.id) {
      replyUploads.discard();
      setReplyDraft('');
    }
    setReplyTarget({
      commentId: comment.id,
      authorName: resolveActor(comment.authorId).name,
    });
  }

  /**
   * Copies an in-app permalink to one comment. There is no shareable web
   * address for a native ticket — this app is the only thing that can open
   * one — so the link is this app's own route plus a `#comment-<id>` hash,
   * absolute against whatever origin the renderer is actually served from
   * (http://localhost:11212 in development, app://waypoint when packaged).
   * Pasted back into a colleague's Waypoint, it lands on the comment.
   *
   * A failed copy is swallowed on purpose, exactly as the Jira surface's
   * own handleCopyCommentLink swallows it: there is no error channel worth
   * interrupting someone for here, and the address is not displayed
   * anywhere in the row for them to fall back to reading.
   */
  async function handleCopyCommentLink(commentId: string) {
    if (!item) return;
    const url = `${window.location.origin}/projects/${projectId}/tickets/${item.identifier}#comment-${commentId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedCommentId(commentId);
      setTimeout(() => setCopiedCommentId(null), 1500);
    } catch {
      // See this function's own comment above.
    }
  }

  /** Feeds the composer's "@" picker. Members only — an agent has no
   *  inbox to be mentioned into, so offering one would promise a
   *  notification nothing sends. */
  //
  // A plain function, not a useCallback: this sits below the early returns,
  // where a hook would change hook count between renders (same reason
  // orderedThreads above is a plain computation). MarkdownEditor debounces
  // the calls itself, so a new identity per render costs nothing.
  async function mentionSource(query: string) {
    const q = query.toLowerCase();
    return (allMembers ?? [])
      .filter((m) => m.displayName.toLowerCase().includes(q))
      .slice(0, 8)
      .map((m) => ({ id: m.id, name: m.displayName }));
  }

  /** Removes one file from an already-posted comment. Confirmed like the
   *  comment delete beside it: the bytes go too, and nothing brings them
   *  back. */
  async function handleDeleteAttachment(comment: Comment, a: Attachment) {
    if (
      !item ||
      // eslint-disable-next-line no-alert
      !window.confirm(`Delete ${a.filename}? This cannot be undone.`)
    ) {
      return;
    }
    await deleteAttachment(a.id);
    reloadComments();
  }

  /** Closing the top composer discards its draft AND aborts anything it
   *  was still uploading — an upload with no composer left to show its
   *  progress is a file nobody asked for. */
  function handleCloseComposer() {
    if (!confirmDiscard(commentDraft, composerUploads.items.length)) return;
    setComposerOpen(false);
    setCommentDraft('');
    composerUploads.discard();
  }

  function handleCancelReply() {
    if (!confirmDiscard(replyDraft, replyUploads.items.length)) return;
    replyUploads.discard();
    setReplyTarget(null);
    setReplyDraft('');
  }

  /** The reply's parentId is the comment actually replied to, even when
   * that comment is itself a reply — groupCommentsIntoThreads flattens the
   * chain back to one visible level, so the thread stays readable while the
   * stored parentage keeps saying who answered whom. */
  async function handlePostReply() {
    if (
      !item ||
      !replyTarget ||
      (!replyDraft.trim() && replyUploads.uploadedIds.length === 0) ||
      replyUploads.uploading ||
      postingReply
    ) {
      return;
    }
    setPostingReply(true);
    try {
      await addComment(
        item.id,
        replyDraft.trim(),
        replyTarget.commentId,
        replyUploads.uploadedIds,
      );
      setReplyDraft('');
      setReplyTarget(null);
      replyUploads.clearAfterPost();
      reloadComments();
      reloadActivity();
    } finally {
      setPostingReply(false);
    }
  }

  /** Edit always targets this one comment's own inline spot, never the
   * shared composer — so any reply in progress there is abandoned (mirrors
   * JiraTicketDetail.tsx's Edit handler). Author-only in the UI as a
   * courtesy (the button itself is gated the same way below); the real
   * enforcement is server-side, in comments.service.ts's editComment,
   * against currentMemberId() — see that function's own comment for why a
   * client-side-only gate here would not be safe to rely on. */
  function handleStartEdit(comment: Comment) {
    if (!confirmAbandonOtherDrafts({ keepEditOf: comment.id })) return;
    setReplyTarget(null);
    setReplyDraft('');
    replyUploads.discard();
    if (editingComment?.commentId !== comment.id) {
      editUploads.discard();
      setEditingComment({ commentId: comment.id, draft: comment.bodyHtml });
    }
  }

  /**
   * Before one composer replaces another, ask whether to throw away what
   * the other one holds. Nothing to lose means no question. `keep…` names
   * the composer being (re)opened, which is not "another" draft.
   */
  function confirmAbandonOtherDrafts(keep: {
    keepReplyTo?: string;
    keepEditOf?: string;
  }): boolean {
    const replyAtRisk =
      replyTarget !== null &&
      replyTarget.commentId !== keep.keepReplyTo &&
      (replyDraft.trim() !== '' || replyUploads.items.length > 0);
    const original = comments?.find(
      (c) => c.id === editingComment?.commentId,
    )?.bodyHtml;
    const editAtRisk =
      editingComment !== null &&
      editingComment.commentId !== keep.keepEditOf &&
      (editingComment.draft !== original || editUploads.items.length > 0);
    if (!replyAtRisk && !editAtRisk) return true;
    let question = 'Discard your unsaved edit?';
    if (replyAtRisk && editAtRisk) {
      question = 'Discard the reply you were writing and your unsaved edit?';
    } else if (replyAtRisk) {
      question = 'Discard the reply you were writing?';
    }
    // eslint-disable-next-line no-alert
    return window.confirm(question);
  }

  function handleCancelEdit() {
    // An edit compares against what the comment already says: backing out
    // of an edit you haven't changed discards nothing.
    const original = comments?.find(
      (c) => c.id === editingComment?.commentId,
    )?.bodyHtml;
    const changed =
      editingComment !== null && editingComment.draft !== original;
    if (!confirmDiscard(changed ? editingComment.draft : '', editUploads.items.length)) {
      return;
    }
    editUploads.discard();
    setEditingComment(null);
  }

  async function handleSaveEdit() {
    if (!item || !editingComment || editUploads.uploading) return;
    // Empty text is allowed only while the comment still carries a file;
    // the server applies the same rule.
    const keptFiles =
      (comments?.find((c) => c.id === editingComment.commentId)?.attachments
        .length ?? 0) + editUploads.uploadedIds.length;
    if (!editingComment.draft.trim() && keptFiles === 0) return;
    setSavingCommentEdit(true);
    try {
      // The comment's existing files PLUS anything this edit uploaded.
      // editComment's attachmentIds is the full set after the edit, not a
      // delta, so omitting the existing ones here would silently delete
      // every file the comment already carried.
      const existing =
        comments?.find((c) => c.id === editingComment.commentId)
          ?.attachments ?? [];
      const editing = comments?.find((c) => c.id === editingComment.commentId);
      await editComment(
        item.id,
        editingComment.commentId,
        editingComment.draft.trim(),
        [...existing.map((a) => a.id), ...editUploads.uploadedIds],
        // The version this edit started from; see editComment in data/api.
        editing ? (editing.updatedAt ?? editing.createdAt) : undefined,
      );
      editUploads.clearAfterPost();
      setEditingComment(null);
      reloadComments();
    } finally {
      setSavingCommentEdit(false);
    }
  }

  /** Same "name the real consequence" confirm() this page's own Delete
   * ticket action already uses (handleDelete below) — a comment delete has
   * no undo either. */
  async function handleDeleteComment(comment: Comment) {
    if (!item) return;
    if (
      !window.confirm(
        'Delete this comment? This cannot be undone, and any reply left under it will move up to the top level.',
      )
    )
      return;
    setDeletingCommentId(comment.id);
    try {
      await deleteComment(item.id, comment.id);
      reloadComments();
    } finally {
      setDeletingCommentId(null);
    }
  }

  /** Anyone who can see the ticket may react — unlike edit/delete, this is
   * intentionally not author-gated (comments.service.ts's
   * toggleCommentReaction). Replaces this one comment's reaction list from
   * the response wholesale, the same "trust the response, not a hand-patch"
   * pattern the rest of this page's writes already follow, rather than a
   * second reloadComments() round trip for a single-emoji change. */
  async function handleToggleReaction(comment: Comment, emoji: string) {
    if (!item) return;
    const reactions = await toggleCommentReaction(item.id, comment.id, emoji);
    setComments((cs) =>
      (cs ?? []).map((c) => (c.id === comment.id ? { ...c, reactions } : c)),
    );
  }

  function handleDelete() {
    if (!item) return;
    if (!window.confirm(`Delete ${item.identifier}? This can't be undone.`))
      return;
    deleteTicket(item.id).then(() => {
      onClose?.();
      navigate(`/projects/${projectId}/tickets`);
    });
  }

  async function handleDuplicate() {
    if (!item) return;
    const copy = await createTicket({
      projectId: item.projectId,
      title: `Copy of ${item.title}`,
      description: item.description,
      stateId: item.stateId,
      priority: item.priority,
      assigneeIds: item.assigneeIds,
      labelIds: item.labelIds,
      workstreamId: item.workstreamId,
      sprintId: item.sprintId,
    });
    onClose?.();
    navigate(`/projects/${item.projectId}/tickets/${copy.identifier}`);
  }

  const commentCount = comments?.length ?? 0;
  // Threads in the order the API returned them (oldest first), with only
  // the ROOT order reversed for the newest-first toggle — reversing the
  // flat list instead would also flip every thread's replies, which reads
  // as an argument running backwards.
  //
  // Not a useMemo: this sits below TicketDetailContent's early returns
  // (loading / not-found), so a hook here would change hook count between
  // renders. Grouping a single ticket's comment list is cheap enough that
  // memoizing it was never worth a conditional hook.
  const orderedThreads = (() => {
    const threads = groupCommentsIntoThreads(comments ?? []);
    return newestFirst ? [...threads].reverse() : threads;
  })();

  /** One comment row — the whole per-comment block the thread below renders
   * twice over (once for a thread's root, once per reply in it), pulled out
   * so both call sites stay identical (mirrors JiraTicketDetail.tsx's own
   * renderComment). Not module-scope: it closes over this render's state
   * and handlers (editingComment, replyTarget, handleStartEdit, …). */
  function renderComment(c: Comment) {
    // renderComment is declared above the early return that narrows
    // `item`, so TypeScript can't know it's defined here even though no
    // call site can reach this without a loaded ticket. A guard rather
    // than a `!`, per this codebase's own rule against non-null
    // assertions on loaded state.
    if (!item) return null;
    const author = resolveActor(c.authorId);
    const isEditing = editingComment?.commentId === c.id;
    const isOwn = currentUser?.id === c.authorId;
    return (
      <div
        key={c.id}
        // The permalink target (handleCopyCommentLink) and the flash
        // target, in that order: the id is what the hash names, and the
        // `data-comment-flash` the effect above sets is styled in the app
        // stylesheet rather than toggled through React state.
        id={`comment-${c.id}`}
        data-comment-id={c.id}
        className={clsx(
          'group flex scroll-mt-20 gap-2.5 rounded-[var(--radius)] transition-colors',
          flashedCommentId === c.id && 'bg-accent-soft-bg',
        )}
      >
        <Avatar
          name={author.name}
          color={author.color}
          shape={author.shape}
          size={26}
        />
        {/* The author line sits ABOVE the body rather than inside
            it, and the body is a filled bubble. Putting the name outside
            gives the bubble its whole width for prose, and makes a run of
            comments scan as a conversation instead of a stack of cards. */}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-sm font-medium text-text">
              {author.shape === 'square'
                ? agentLabel(author.name)
                : author.name}
            </span>
            {author.model && (
              <Badge tone="info" className="px-1.5 py-0 text-[10px] leading-4">
                {author.model}
              </Badge>
            )}
            <span
              className="text-xs text-text-muted"
              // The relative form still exists, just where it belongs:
              // good for "this just happened", bad for citing a date.
              title={formatRelativeTime(c.createdAt)}
            >
              {formatCommentTime(c.createdAt)}
              {/* ROAD-162: null until the first edit (schema/tickets.ts's
                  comments.updatedAt) — so this only ever shows once it's
                  genuinely true, not a timestamp that merely duplicates
                  createdAt. */}
              {c.updatedAt && ' · (edited)'}
            </span>
          </div>
          {isEditing && editingComment ? (
            // Replaces this one comment's own body and action row with an
            // inline editor, right where the comment already sits (mirrors
            // JiraCommentComposer's inline edit in JiraTicketDetail.tsx).
            // Everything else in the thread, including every other
            // comment's own position, is untouched.
            <div className="mt-0.5">
              <MarkdownEditor
                autoFocus
                minRows={3}
                ariaLabel="Edit comment"
                value={editingComment.draft}
                onChange={(draft) =>
                  setEditingComment({ commentId: c.id, draft })
                }
                onSubmit={handleSaveEdit}
                onCancel={handleCancelEdit}
                onFiles={(files) => editUploads.addFiles(item.id, files)}
                mentionSource={mentionSource}
                footerActions={
                  <>
                    <Button variant="ghost" size="sm" onClick={handleCancelEdit}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={
                        (!editingComment.draft.trim() &&
                          c.attachments.length +
                            editUploads.uploadedIds.length ===
                            0) ||
                        editUploads.uploading ||
                        savingCommentEdit
                      }
                      onClick={handleSaveEdit}
                    >
                      {submitLabel(
                        editUploads.uploading,
                        savingCommentEdit,
                        'Saving…',
                        'Save',
                      )}
                    </Button>
                  </>
                }
              />
              <AttachmentTray
                items={editUploads.items}
                onRetry={(key) => editUploads.retry(item.id, key)}
                onRemove={editUploads.remove}
              />
            </div>
          ) : (
            <>
              {/* A comment may be files alone; then there is no text
                  bubble at all rather than an empty one. */}
              {c.bodyHtml.trim() !== '' &&
                (author.model || isDisclosedAgentHtml(c.bodyHtml) ? (
                // Agent-authored comments are the one case where bodyHtml
                // genuinely is HTML: proposals.service.ts builds it with
                // buildCopilotCommentHtml, which escapes the display name
                // and the model's body first and only ever wraps them in a
                // fixed <p>/<em> template (waypoint-backend/src/lib/commentHtml.ts)
                // — no path from model output to an unescaped tag. Those
                // comments are posted as the person who approved them
                // (a member, not an agent — "Posted as you"), so the
                // author alone does not say so: the builder's own
                // disclosure opening does (isDisclosedAgentHtml).
                <div
                  className={clsx(COMMENT_BUBBLE, 'copilot-md')}
                  dangerouslySetInnerHTML={{ __html: c.bodyHtml }}
                />
              ) : (
                // ROAD-162: bodyHtml for a human-typed comment is markdown
                // SOURCE (see validation/tickets.schema.ts's addCommentSchema
                // comment) — rendered through renderMarkdown (lib/markdown.ts),
                // which escapes every HTML metacharacter FIRST and only then
                // emits its own small, fixed vocabulary of tags. That escape
                // pass is what makes dangerouslySetInnerHTML safe here: a
                // typed `<img onerror=…>` comes back as the literal text
                // `&lt;img onerror=…&gt;`, never a live element — same
                // invariant the old plain-text render had, now met by
                // escaping instead of by never parsing HTML at all (see
                // TicketDetailPage.test.tsx's "stored XSS fix" suite, which
                // asserts exactly that).
                <div
                  className={clsx(COMMENT_BUBBLE, 'copilot-md')}
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(c.bodyHtml),
                  }}
                />
              ))}
              {c.attachments.length > 0 && (
                <div className="mt-2">
                  {/* AttachmentList owns its own lightbox — it already
                      knows which of its items are images and where the
                      clicked one sits in that set, so hoisting the state
                      to this page only duplicated it. */}
                  <AttachmentList
                    attachments={c.attachments}
                    // Not the only file of a comment with no text: deleting
                    // it would leave an empty comment, which the server
                    // refuses. Deleting the comment is the way to remove it.
                    canDelete={
                      isOwn &&
                      !(c.bodyHtml.trim() === '' && c.attachments.length === 1)
                    }
                    onDelete={(a) => handleDeleteAttachment(c, a)}
                  />
                </div>
              )}
              {c.reactions.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {c.reactions.map((r) => {
                    const reacted = currentUser
                      ? r.actorIds.includes(currentUser.id)
                      : false;
                    return (
                      <button
                        key={r.emoji}
                        type="button"
                        onClick={() => handleToggleReaction(c, r.emoji)}
                        title={r.actorIds
                          .map((id) => resolveActor(id).name)
                          .join(', ')}
                        // Distinct from `title` above on purpose: `title` is
                        // a mouse-only hover tooltip and, being just a name
                        // or list of names, collides with every Avatar's own
                        // `title={name}` elsewhere in this thread (a
                        // screen-reader user tabbing here would otherwise
                        // hear the same bare name an avatar just announced,
                        // with no hint this is a toggleable reaction at all).
                        aria-label={`${r.emoji} reaction (${r.actorIds.length}) — click to toggle`}
                        className={clsx(
                          'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]',
                          reacted
                            ? 'border-accent bg-accent-soft-bg/60 text-accent'
                            : 'border-border bg-surface-2 text-text-muted hover:border-border-strong',
                        )}
                      >
                        <span>{r.emoji}</span>
                        <span>{r.actorIds.length}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {/* Always visible, deliberately. These were opacity-0 until
                  hover (copied from the Jira surface's own row actions),
                  which on a comment thread means Reply — the one action
                  that makes threading discoverable at all — is invisible
                  until you happen to sweep the mouse over a comment, and
                  never visible on touch. Muted by default and lit on
                  hover is enough restraint. */}
              <div className="mt-1.5 flex items-center gap-1.5">
                {/* Reply is the one action that carries a word as well as
                    an icon, because it is the one that makes threading
                    exist at all — the others are recognisable from their
                    glyph and have tooltips; this one had to stop being a
                    guess. */}
                <button
                  type="button"
                  onClick={() => handleReplyClick(c)}
                  className={COMMENT_ACTION_CHIP}
                >
                  <ReplyIcon size={COMMENT_ACTION_ICON} aria-hidden />
                  Reply
                </button>
                <Dropdown
                  trigger={(toggle) => (
                    <Tooltip label="Add reaction">
                      <button
                        type="button"
                        onClick={toggle}
                        aria-label="Add reaction"
                        className="flex size-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
                      >
                        <SmilePlus size={COMMENT_ACTION_ICON} aria-hidden />
                      </button>
                    </Tooltip>
                  )}
                >
                  {(close) => (
                    <EmojiPickerPanel
                      onSelect={(emoji) => {
                        handleToggleReaction(c, emoji);
                        close();
                      }}
                    />
                  )}
                </Dropdown>
                <Tooltip
                  label={
                    copiedCommentId === c.id ? 'Link copied' : 'Copy link'
                  }
                >
                  <button
                    type="button"
                    onClick={() => handleCopyCommentLink(c.id)}
                    aria-label={
                      copiedCommentId === c.id ? 'Link copied' : 'Copy link'
                    }
                    className="flex size-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
                  >
                    {copiedCommentId === c.id ? (
                      <IconCheck size={COMMENT_ACTION_ICON} />
                    ) : (
                      <Link2 size={COMMENT_ACTION_ICON} aria-hidden />
                    )}
                  </button>
                </Tooltip>
                {isOwn && (
                  <Tooltip label="Edit">
                    <button
                      type="button"
                      onClick={() => handleStartEdit(c)}
                      aria-label="Edit"
                      className="flex size-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
                    >
                      <Pencil size={COMMENT_ACTION_ICON} aria-hidden />
                    </button>
                  </Tooltip>
                )}
                {isOwn && (
                  <Tooltip
                    label={deletingCommentId === c.id ? 'Deleting…' : 'Delete'}
                  >
                    <button
                      type="button"
                      disabled={deletingCommentId === c.id}
                      onClick={() => handleDeleteComment(c)}
                      aria-label={
                        deletingCommentId === c.id ? 'Deleting…' : 'Delete'
                      }
                      className="flex size-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-50"
                    >
                      <Trash2 size={COMMENT_ACTION_ICON} aria-hidden />
                    </button>
                  </Tooltip>
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
      className={
        isDrawer
          ? 'flex h-full flex-col overflow-y-auto'
          : 'mx-auto flex max-w-[1400px] flex-col md:flex-row'
      }
    >
      <div
        className={clsx(
          'min-w-0 flex-1',
          !isDrawer && 'md:border-r md:border-border',
        )}
      >
        {/* Breadcrumb */}
        <div className="flex items-center justify-between border-b border-border px-6 py-3 md:px-8">
          {isDrawer ? (
            <div className="flex min-w-0 items-center gap-1.5 text-sm text-text-secondary">
              <span className="shrink-0 font-mono text-text">
                {item.identifier}
              </span>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 text-sm text-text-secondary">
              <Link
                to={`/projects/${projectId}/tickets`}
                className="truncate hover:text-text"
              >
                {project.name}
              </Link>
              <IconChevronRight
                size={14}
                className="shrink-0 text-text-muted"
              />
              <Link
                to={`/projects/${projectId}/tickets`}
                className="shrink-0 hover:text-text"
              >
                Tickets
              </Link>
              <IconChevronRight
                size={14}
                className="shrink-0 text-text-muted"
              />
              <span className="shrink-0 font-mono text-text">
                {item.identifier}
              </span>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1">
            {onExpand && (
              <IconButton label="Open full page" onClick={onExpand}>
                <Maximize2 size={15} />
              </IconButton>
            )}
            <Dropdown
              align="right"
              trigger={(toggle) => (
                <IconButton label="Ticket actions" onClick={toggle}>
                  <MoreHorizontal size={16} />
                </IconButton>
              )}
            >
              {(close) => (
                <div className="w-48 rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg">
                  <MenuItem
                    icon={<Copy size={14} />}
                    label="Make a copy"
                    onClick={() => {
                      close();
                      handleDuplicate();
                    }}
                  />
                  <div className="my-1 h-px bg-border" />
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    label="Delete"
                    danger
                    onClick={() => {
                      close();
                      handleDelete();
                    }}
                  />
                </div>
              )}
            </Dropdown>
            {onClose && (
              <IconButton label="Close" onClick={onClose}>
                <IconX size={16} />
              </IconButton>
            )}
          </div>
        </div>

        {/* Title */}
        <div className="px-6 pt-5 md:px-8">
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            placeholder="Ticket title"
            className="-mx-2 w-full truncate rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 py-1 font-display text-xl font-semibold text-text outline-none focus:border-border-strong focus:bg-surface-2"
          />
        </div>

        {/* Description */}
        <div className="mt-2 px-6 md:px-8">
          <textarea
            ref={descTextareaRef}
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={saveDescription}
            placeholder="Add description…"
            className="thin-scroll -mx-2 w-full resize-none overflow-y-auto rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 py-1.5 text-sm text-text-secondary outline-none focus:border-border-strong focus:bg-surface-2"
            style={{ maxHeight: DESCRIPTION_MAX_HEIGHT }}
          />
        </div>

        {/* Action row */}
        <div className="mt-4 flex flex-wrap items-center gap-2 px-6 md:px-8">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCreateSubOpen(true)}
          >
            <IconPlus size={14} /> Add subtask
          </Button>
          <Button variant="secondary" size="sm" disabled title="Coming soon">
            <GitMerge size={14} /> Add relation
            <Badge tone="neutral" className="px-1.5 py-0 text-[10px] leading-4">
              Soon
            </Badge>
          </Button>
          <Dropdown
            trigger={(toggle) => (
              <Button variant="secondary" size="sm" onClick={toggle}>
                <LinkIcon size={14} /> Add link
              </Button>
            )}
          >
            {(close) => (
              <AddLinkForm
                onCancel={close}
                onAdd={(url, label) => {
                  handleAddLink(url, label);
                  close();
                }}
              />
            )}
          </Dropdown>
          {/* Was a disabled "Attach · Soon" sitting directly above a
              comment section where attaching already worked (review
              finding: it told a first-time reader attachments didn't exist
              before they reached the part where they plainly did). It now
              does exactly what the comments header's "Attach files" does:
              pick files, open the composer, start the upload. Attachments
              live on comments, so that is where these land. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => headerFileInputRef.current?.click()}
          >
            <Paperclip size={14} /> Attach
          </Button>
        </div>

        {/* Links */}
        {itemLinks.length > 0 && (
          <div className="mt-3 flex flex-col gap-1.5 px-6 md:px-8">
            {itemLinks.map((link) => (
              <div
                key={link.id}
                className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-surface px-3 py-1.5 text-sm"
              >
                <LinkIcon size={13} className="shrink-0 text-text-muted" />
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-text hover:text-accent hover:underline"
                >
                  {link.label}
                </a>
                <IconButton
                  label={`Remove link ${link.label}`}
                  onClick={() => handleRemoveLink(link.id)}
                >
                  <IconX size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        {/* Subtasks */}
        {subItems && subItems.length > 0 && (
          <div className="mt-6 px-6 md:px-8">
            <h3 className="mb-2 font-display text-sm font-medium text-text">
              Subtasks ({subItems.length})
              {subItemsWithPoints.length > 0 && ` · ${subItemsPointsTotal} pts`}
            </h3>
            <div className="mb-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${subItemsProgress}%` }}
                />
              </div>
              <span className="shrink-0 text-xs text-text-muted">
                {doneSubItems} of {subItemsList.length} done
              </span>
            </div>
            <div className="divide-y divide-border rounded-[var(--radius)] border border-border">
              {subItems.map((child) => {
                const childState = statesById.get(child.stateId);
                return (
                  <Link
                    key={child.id}
                    to={`/projects/${projectId}/tickets/${child.identifier}`}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2"
                  >
                    {childState && <StateIcon state={childState} />}
                    <span className="shrink-0 font-mono text-xs text-text-muted">
                      {child.identifier}
                    </span>
                    <span className="truncate text-text">{child.title}</span>
                    <PriorityIcon priority={child.priority} />
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* Activity */}
        <div className="mt-6 px-6 md:px-8">
          <TicketActivity
            entries={activity}
            comments={comments}
            commentsLoaded={comments !== undefined && !commentsError}
            statesById={statesById}
            resolveActor={resolveActor}
            projectId={projectId}
            onJumpToComment={jumpToComment}
          />
        </div>

        {/* W3: this ticket's agent runs, with a way into the sessions panel
            (ROAD-65). Same no-empty-state rule as Pending proposals below. */}
        <TicketRunsSection ticketId={item.id} />

        {/* Pending proposals — no empty state: a ticket with nothing pending
            shows no section at all (honesty-lint: don't imply agent activity
            that isn't there). */}
        {ticketProposals.length > 0 && (
          <div className="mt-6 px-6 md:px-8">
            <h3 className="mb-2 font-display text-sm font-medium text-text">
              Pending proposals ({ticketProposals.length})
            </h3>
            <div className="flex flex-col gap-3">
              {ticketProposals.map((p) => (
                <CopilotProposalCard
                  key={p.id}
                  proposal={p}
                  onApprove={approveProposal}
                  onReject={rejectProposal}
                />
              ))}
            </div>
          </div>
        )}

        {/* Comments */}
        <div className="mt-6 mb-8 px-6 md:px-8">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-display text-sm font-medium text-text">
              Comments{commentCount > 0 && ` (${commentCount})`}
            </h3>
            <div className="flex items-center gap-1.5">
              {/* Attach Files lives in the section header, not only inside
                  the composer's toolbar, and it earns its place:
                  dragging a screenshot at a thread you have not started
                  writing in yet is the common case, and this opens the
                  composer with the upload already running. */}
              <button
                type="button"
                onClick={() => headerFileInputRef.current?.click()}
                className={COMMENT_ACTION_CHIP}
              >
                <Paperclip size={COMMENT_ACTION_ICON} aria-hidden />
                Attach files
              </button>
              <input
                ref={headerFileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) {
                    setComposerOpen(true);
                    composerUploads.addFiles(item.id, files);
                  }
                  // Reset, so picking the SAME file again still fires a
                  // change event.
                  e.target.value = '';
                }}
              />
            {commentCount > 1 && (
              <button
                type="button"
                onClick={() => setNewestFirst((v) => !v)}
                className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                {newestFirst ? 'Newest first' : 'Oldest first'}
              </button>
            )}
            </div>
          </div>

          {/* The composer sits ABOVE the thread, not below it. A thread of
              any length used to bury the only way to add to it off the
              bottom of the page; putting it first is both what Jira does
              and the only placement that stays reachable as a ticket
              accumulates comments. Collapsed until clicked (composerOpen)
              so it costs one line rather than a permanent textarea. */}
          <div className="flex gap-2.5">
            <Avatar
              name={currentUser?.displayName ?? 'Me'}
              color={currentUser?.avatarColor}
              size={26}
            />
            <div
              ref={commentFormRef}
              tabIndex={-1}
              // See CopilotProposalCard.tsx's identical marker: the comment
              // button's `disabled` state force-blurs focus onto this
              // container, and without this marker the next keystroke would
              // still be free to fire a global nav shortcut.
              data-shortcut-guard
              className="min-w-0 flex-1 outline-none"
            >
              {composerOpen ? (
                <>
                  <MarkdownEditor
                    autoFocus
                    minRows={4}
                    value={commentDraft}
                    onChange={setCommentDraft}
                    placeholder="Leave a comment…"
                    ariaLabel="Leave a comment"
                    onSubmit={handlePostComment}
                    onCancel={handleCloseComposer}
                    onFiles={(files) =>
                      composerUploads.addFiles(item.id, files)
                    }
                    mentionSource={mentionSource}
                    footerActions={
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleCloseComposer}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={
                            // A comment may be files alone — a screenshot
                            // with no words is a real comment, and
                            // requiring prose to send one would be this
                            // surface inventing a rule of its own.
                            (!commentDraft.trim() &&
                              composerUploads.uploadedIds.length === 0) ||
                            // Wait for every file: posting mid-upload
                            // used to send the comment without it.
                            composerUploads.uploading ||
                            postingComment
                          }
                          onClick={handlePostComment}
                        >
                          {submitLabel(
                            composerUploads.uploading,
                            postingComment,
                            'Posting…',
                            'Comment',
                          )}
                        </Button>
                      </>
                    }
                  />
                  <AttachmentTray
                    items={composerUploads.items}
                    onRetry={(key) => composerUploads.retry(item.id, key)}
                    onRemove={composerUploads.remove}
                  />
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setComposerOpen(true)}
                  className="w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-left text-sm text-text-muted transition-colors hover:border-accent hover:text-text-secondary"
                >
                  Leave a comment…
                </button>
              )}
            </div>
          </div>

          {/* Three states the thread had none of before: a first load, a
              failure, and a genuinely empty thread. The composer above
              renders in all three — you can always start a conversation,
              even when reading the existing one failed. */}
          {commentsLoading && comments === undefined && (
            <div className="mt-5 flex flex-col gap-3" aria-hidden>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {commentsError && (
            <div className="mt-5 flex items-center justify-between rounded-[var(--radius-sm)] border border-border bg-surface-2 px-3 py-2 text-sm text-text-secondary">
              <span>Couldn&apos;t load this ticket&apos;s comments.</span>
              <Button variant="ghost" size="sm" onClick={() => reloadComments()}>
                Retry
              </Button>
            </div>
          )}
          {!commentsLoading && !commentsError && commentCount === 0 && (
            <p className="mt-5 text-sm text-text-muted">
              No comments yet.
            </p>
          )}

          <div className="mt-5 space-y-4">
            {/* ROAD-162: nested, not flat — a reply renders under the
                comment it answers instead of beside it, one visible level
                deep (groupCommentsIntoThreads, shared with the Jira comment
                surface — see lib/commentThreads.ts's own comment).
                `orderedThreads` only ever reverses the ROOT order for the
                newest-first toggle; replies inside a thread stay in the
                order they were written, which is the only order a
                conversation reads in. */}
            {orderedThreads.map(({ root, replies }) => {
              const replyOpenHere =
                replyTarget !== null &&
                (replyTarget.commentId === root.id ||
                  replies.some((r) => r.id === replyTarget.commentId));
              return (
                <div key={root.id}>
                  {renderComment(root)}
                  {(replies.length > 0 || replyOpenHere) && (
                    <div className="mt-3 ml-9 space-y-3 border-l border-border pl-3">
                      {replies.map((reply) => renderComment(reply))}
                      {replyOpenHere && replyTarget && (
                        <div className="flex gap-2.5">
                          <Avatar
                            name={currentUser?.displayName ?? 'Me'}
                            color={currentUser?.avatarColor}
                            size={22}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="mb-1.5 flex items-center justify-between text-xs text-text-muted">
                              <span>
                                Replying to{' '}
                                <span className="font-medium text-text">
                                  {replyTarget.authorName}
                                </span>
                              </span>
                              <button
                                type="button"
                                onClick={handleCancelReply}
                                aria-label="Cancel reply"
                                className="text-text-muted hover:text-text"
                              >
                                <IconX size={13} />
                              </button>
                            </div>
                            <MarkdownEditor
                              autoFocus
                              minRows={3}
                              value={replyDraft}
                              onChange={setReplyDraft}
                              placeholder={`Reply to ${replyTarget.authorName}…`}
                              ariaLabel={`Reply to ${replyTarget.authorName}`}
                              onSubmit={handlePostReply}
                              onCancel={handleCancelReply}
                              onFiles={(files) =>
                                replyUploads.addFiles(item.id, files)
                              }
                              mentionSource={mentionSource}
                              footerActions={
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleCancelReply}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    disabled={
                                      (!replyDraft.trim() &&
                                        replyUploads.uploadedIds.length ===
                                          0) ||
                                      replyUploads.uploading ||
                                      postingReply
                                    }
                                    onClick={handlePostReply}
                                  >
                                    {submitLabel(
                                      replyUploads.uploading,
                                      postingReply,
                                      'Posting…',
                                      // Deliberately "Post reply", not
                                      // "Reply" — a comment's own Reply
                                      // trigger (renderComment above)
                                      // already carries that exact
                                      // accessible name, and a screen
                                      // reader (or a test) can't otherwise
                                      // tell the two apart once both are
                                      // on screen at once.
                                      'Post reply',
                                    )}
                                  </Button>
                                </>
                              }
                            />
                            <AttachmentTray
                              items={replyUploads.items}
                              onRetry={(key) =>
                                replyUploads.retry(item.id, key)
                              }
                              onRemove={replyUploads.remove}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Properties panel */}
      <aside
        className={clsx(
          'w-full shrink-0 border-t border-border px-6 py-5',
          !isDrawer &&
            'md:w-[300px] md:self-start md:border-t-0 md:px-5 md:py-6',
        )}
      >
        <PropertyRow label="State">
          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
                {currentState && <StateIcon state={currentState} />}
                <span className="truncate">
                  {currentState?.name ?? 'No state'}
                </span>
                <IconChevron
                  size={13}
                  className="ml-auto shrink-0 text-text-muted"
                />
              </button>
            )}
          >
            {(close) => (
              <div className={PANEL_CLASS}>
                {(states ?? []).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      patchItem({ stateId: s.id });
                      close();
                    }}
                    className={OPTION_CLASS}
                  >
                    <StateIcon state={s} />
                    <span className="truncate">{s.name}</span>
                    {s.id === item.stateId && (
                      <IconCheck
                        size={14}
                        className="ml-auto shrink-0 text-accent"
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </Dropdown>
        </PropertyRow>

        {itemAgentAssignments.length > 0 && (
          <PropertyRow label="Agent">
            <div className="flex flex-col gap-1.5">
              {itemAgentAssignments.map((assignment) => {
                const agent = agentsById.get(assignment.agentId);
                if (!agent) return null;
                return (
                  <div
                    key={assignment.id}
                    className="flex h-8 items-center gap-2 px-2 text-sm"
                  >
                    <Avatar
                      name={agent.name}
                      color={agent.avatarColor}
                      shape="square"
                      size={20}
                    />
                    <span className="truncate text-text">
                      {agentLabel(agent.name)}
                    </span>
                    <AgentStatusBadge
                      status={assignment.status}
                      className="ml-auto"
                    />
                  </div>
                );
              })}
            </div>
          </PropertyRow>
        )}

        <PropertyRow label="Assignees">
          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
                {assignedActors.length > 0 ? (
                  <AvatarStack people={assignedActors} size={22} />
                ) : (
                  <span className="flex items-center gap-1.5 text-text-muted">
                    <UserPlus size={14} /> Add assignees
                  </span>
                )}
                <IconChevron
                  size={13}
                  className="ml-auto shrink-0 text-text-muted"
                />
              </button>
            )}
          >
            {() => (
              <div className={PANEL_CLASS}>
                {projectMembers.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-text-muted">
                    No project members.
                  </p>
                )}
                {projectMembers.map((m) => {
                  const checked = item.assigneeIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleAssignee(m.id)}
                      className={OPTION_CLASS}
                    >
                      <Avatar
                        name={m.displayName}
                        color={m.avatarColor}
                        size={20}
                      />
                      <span className="truncate">{m.displayName}</span>
                      {checked && (
                        <IconCheck
                          size={14}
                          className="ml-auto shrink-0 text-accent"
                        />
                      )}
                    </button>
                  );
                })}
                <div className="my-1 h-px bg-border" />
                <p className="px-2 py-1 font-mono text-[10px] tracking-wide text-text-muted uppercase">
                  Agents
                </p>
                {projectAgents.map((a) => {
                  const checked = item.assigneeIds.includes(a.id);
                  const assignment = itemAgentAssignments.find(
                    (x) => x.agentId === a.id,
                  );
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAgent(a.id)}
                      className={OPTION_CLASS}
                    >
                      <Avatar
                        name={a.name}
                        color={a.avatarColor}
                        shape="square"
                        size={20}
                      />
                      <span className="truncate">
                        {agentLabel(a.name)}{' '}
                        <span className="text-text-muted">— {a.model}</span>
                      </span>
                      {assignment && (
                        <Dot
                          color={AGENT_STATUS_CONFIG[assignment.status].dot}
                          className={clsx(
                            'ml-auto',
                            assignment.status === 'running' && 'animate-pulse',
                          )}
                        />
                      )}
                      {checked && (
                        <IconCheck size={14} className="shrink-0 text-accent" />
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/settings/agents/new?returnTo=${encodeURIComponent(
                        `/projects/${projectId}/tickets/${item.identifier}`,
                      )}&projectId=${item.projectId}`,
                    )
                  }
                  className={clsx(OPTION_CLASS, 'text-text-muted')}
                >
                  <IconPlus size={14} className="shrink-0" />
                  Create new agent
                </button>
              </div>
            )}
          </Dropdown>
        </PropertyRow>

        <PropertyRow label="Priority">
          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
                <PriorityIcon priority={item.priority} />
                <span className="truncate">
                  {PRIORITY_LABEL[item.priority]}
                </span>
                <IconChevron
                  size={13}
                  className="ml-auto shrink-0 text-text-muted"
                />
              </button>
            )}
          >
            {(close) => (
              <div className={PANEL_CLASS}>
                {PRIORITY_ORDER.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      patchItem({ priority: p });
                      close();
                    }}
                    className={OPTION_CLASS}
                  >
                    <PriorityIcon priority={p} />
                    <span className="truncate">{PRIORITY_LABEL[p]}</span>
                    {p === item.priority && (
                      <IconCheck
                        size={14}
                        className="ml-auto shrink-0 text-accent"
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </Dropdown>
        </PropertyRow>

        {/* Finding 7a: `estimatePoints` is a free, unconstrained numeric
            field — distinct from `estimateValue` below (constrained to the
            project's configured Fibonacci/T-shirt preset) — so it's real
            data can be non-Fibonacci values like 17.5. Deliberately always
            visible, unlike the Estimate row below, since it doesn't depend
            on `project.estimate` being configured at all. */}
        <PropertyRow label="Story points">
          <input
            type="number"
            step="0.5"
            min="0"
            value={pointsDraft}
            onChange={(e) => setPointsDraft(e.target.value)}
            onBlur={savePoints}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            placeholder="No estimate"
            className="h-8 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2 text-sm text-text outline-none focus:border-accent"
          />
        </PropertyRow>

        {estimateSystem && (
          <PropertyRow label="Estimate">
            <Dropdown
              trigger={(toggle) => (
                <button
                  type="button"
                  onClick={toggle}
                  className={TRIGGER_CLASS}
                >
                  <Ruler size={14} className="shrink-0 text-text-muted" />
                  <span className="truncate">
                    {item.estimateValue ?? 'No estimate'}
                  </span>
                  <IconChevron
                    size={13}
                    className="ml-auto shrink-0 text-text-muted"
                  />
                </button>
              )}
            >
              {(close) => (
                <div className={PANEL_CLASS}>
                  <button
                    type="button"
                    onClick={() => {
                      patchItem({ estimateValue: null });
                      close();
                    }}
                    className={OPTION_CLASS}
                  >
                    <span className="truncate text-text-secondary">
                      No estimate
                    </span>
                    {!item.estimateValue && (
                      <IconCheck
                        size={14}
                        className="ml-auto shrink-0 text-accent"
                      />
                    )}
                  </button>
                  {estimateSystem.values.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => {
                        patchItem({ estimateValue: v });
                        close();
                      }}
                      className={OPTION_CLASS}
                    >
                      <span className="truncate">{v}</span>
                      {item.estimateValue === v && (
                        <IconCheck
                          size={14}
                          className="ml-auto shrink-0 text-accent"
                        />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </Dropdown>
          </PropertyRow>
        )}

        <PropertyRow label="Created by">
          <div className="flex h-8 items-center gap-2 px-2 text-sm text-text">
            <Avatar
              name={creator?.displayName ?? 'Unknown'}
              color={creator?.avatarColor}
              size={20}
            />
            <span className="truncate">
              {creator?.displayName ?? 'Unknown'}
            </span>
          </div>
        </PropertyRow>

        <PropertyRow label="Start date">
          <DatePicker
            value={item.startDate ? item.startDate.slice(0, 10) : null}
            onChange={(startDate) => patchItem({ startDate })}
          />
        </PropertyRow>

        <PropertyRow label="Due date">
          <DatePicker
            value={item.dueDate ? item.dueDate.slice(0, 10) : null}
            onChange={(dueDate) => patchItem({ dueDate })}
          />
        </PropertyRow>

        <PropertyRow label="Workstream">
          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
                <IconLayers size={14} className="shrink-0 text-text-muted" />
                <span className="truncate">
                  {currentWorkstream?.name ?? 'No workstream'}
                </span>
                <IconChevron
                  size={13}
                  className="ml-auto shrink-0 text-text-muted"
                />
              </button>
            )}
          >
            {(close) => (
              <div className={PANEL_CLASS}>
                <button
                  type="button"
                  onClick={() => {
                    patchItem({ workstreamId: null });
                    close();
                  }}
                  className={OPTION_CLASS}
                >
                  <span className="truncate text-text-secondary">
                    No workstream
                  </span>
                  {!item.workstreamId && (
                    <IconCheck
                      size={14}
                      className="ml-auto shrink-0 text-accent"
                    />
                  )}
                </button>
                {(workstreams ?? []).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      patchItem({ workstreamId: m.id });
                      close();
                    }}
                    className={OPTION_CLASS}
                  >
                    <span className="truncate">{m.name}</span>
                    {item.workstreamId === m.id && (
                      <IconCheck
                        size={14}
                        className="ml-auto shrink-0 text-accent"
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </Dropdown>
        </PropertyRow>

        <PropertyRow label="Sprint">
          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
                <Repeat size={14} className="shrink-0 text-text-muted" />
                <span className="truncate">
                  {currentSprint?.name ?? 'No sprint'}
                </span>
                <IconChevron
                  size={13}
                  className="ml-auto shrink-0 text-text-muted"
                />
              </button>
            )}
          >
            {(close) => (
              <div className={PANEL_CLASS}>
                <button
                  type="button"
                  onClick={() => {
                    patchItem({ sprintId: null });
                    close();
                  }}
                  className={OPTION_CLASS}
                >
                  <span className="truncate text-text-secondary">
                    No sprint
                  </span>
                  {!item.sprintId && (
                    <IconCheck
                      size={14}
                      className="ml-auto shrink-0 text-accent"
                    />
                  )}
                </button>
                {(sprints ?? []).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      patchItem({ sprintId: c.id });
                      close();
                    }}
                    className={OPTION_CLASS}
                  >
                    <span className="truncate">{c.name}</span>
                    {item.sprintId === c.id && (
                      <IconCheck
                        size={14}
                        className="ml-auto shrink-0 text-accent"
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </Dropdown>
        </PropertyRow>

        <PropertyRow label="Parent">
          {item.parentId && parentItem ? (
            <div className="flex h-8 items-center gap-1.5 px-2">
              <Link
                to={`/projects/${projectId}/tickets/${parentItem.identifier}`}
                className="flex min-w-0 items-center gap-1.5 truncate text-sm text-text hover:text-accent"
              >
                <span className="shrink-0 font-mono text-xs text-text-muted">
                  {parentItem.identifier}
                </span>
                <span className="truncate">{parentItem.title}</span>
              </Link>
              <IconButton
                label="Clear parent"
                onClick={() => patchItem({ parentId: null })}
                className="ml-auto"
              >
                <IconX size={13} />
              </IconButton>
            </div>
          ) : (
            <div className="flex h-8 items-center px-2 text-sm text-text-muted">
              None
            </div>
          )}
        </PropertyRow>

        <PropertyRow label="Labels">
          <Dropdown
            trigger={(toggle) => (
              <button
                type="button"
                onClick={toggle}
                className={clsx(TRIGGER_CLASS, 'h-auto min-h-8 flex-wrap py-1')}
              >
                {itemLabels.length > 0 ? (
                  <span className="flex flex-1 flex-wrap gap-1">
                    {itemLabels.map((l) => (
                      <span
                        key={l.id}
                        className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
                      >
                        <Dot color={l.color} /> {l.name}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-text-muted">
                    <Tag size={14} /> Add labels
                  </span>
                )}
                <IconChevron
                  size={13}
                  className="ml-auto shrink-0 text-text-muted"
                />
              </button>
            )}
          >
            {() => (
              <div className={PANEL_CLASS}>
                {(labels ?? []).length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-text-muted">
                    No labels in this project.
                  </p>
                )}
                {(labels ?? []).map((l) => {
                  const checked = item.labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => toggleLabel(l.id)}
                      className={OPTION_CLASS}
                    >
                      <Dot color={l.color} />
                      <span className="truncate">{l.name}</span>
                      {checked && (
                        <IconCheck
                          size={14}
                          className="ml-auto shrink-0 text-accent"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </Dropdown>
        </PropertyRow>
      </aside>

      <CreateTicketModal
        open={createSubOpen}
        onClose={() => setCreateSubOpen(false)}
        projectId={item.projectId}
        defaultParentId={item.id}
        onCreated={handleSubItemCreated}
      />
    </div>
  );
}

/** Route entry: resolves `:projectId`/`:identifier` from the URL and renders the full page. */
export default function TicketDetailPage() {
  const { projectId = '', identifier = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const newAgentId = searchParams.get('newAgentId') ?? undefined;
  return (
    <TicketDetailContent
      projectId={projectId}
      identifier={identifier}
      variant="page"
      autoAssignAgentId={newAgentId}
      onAutoAssigned={() => {
        const next = new URLSearchParams(searchParams);
        next.delete('newAgentId');
        setSearchParams(next, { replace: true });
      }}
    />
  );
}
