import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  Copy,
  GitMerge,
  Link as LinkIcon,
  Maximize2,
  MoreHorizontal,
  Paperclip,
  Repeat,
  Ruler,
  Tag,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { IconCheck, IconChevron, IconChevronRight, IconLayers, IconPlus, IconX } from '@/components/icons';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { useRecordRecent } from '@/lib/recents';
import {
  addComment,
  addTicketLink,
  createTicket,
  deleteTicket,
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
  toggleTicketAgent,
  toggleTicketAssignee,
  toggleTicketLabel,
  updateTicket,
} from '@/data/api';
import type { Ticket } from '@/types/entities';
import { Avatar, AvatarStack } from '@/components/ui/Avatar';
import { Badge, Dot } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { DatePicker } from '@/components/ui/DatePicker';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { CopilotProposalCard } from '@/components/domain/CopilotProposalCard';
import { CreateTicketModal } from '@/components/domain/CreateTicketModal';
import { agentLabel } from '@/lib/agentLabel';
import { AGENT_STATUS_CONFIG, AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { PRIORITY_LABEL, PRIORITY_ORDER, PriorityIcon } from '@/components/domain/PriorityIcon';
import { StateIcon } from '@/components/domain/StateIcon';
import {
  approveProposal,
  rejectProposal,
  upsertProposals,
  useAllProposals,
} from '@/lib/proposalStore';

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
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
        <div className={clsx('absolute z-30 mt-1', align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-1.5 w-[104px] shrink-0 text-xs text-text-muted">{label}</span>
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
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
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
        <Button variant="primary" size="sm" disabled={!url.trim()} onClick={submit}>
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
    () => (needsProjectFetch ? getProject(itemProjectId) : Promise.resolve(undefined)),
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
    () => (itemProjectId ? listWorkstreams(itemProjectId) : Promise.resolve([])),
    [itemProjectId],
  );
  const { data: sprints } = useAsync(
    () => (itemProjectId ? listSprints(itemProjectId) : Promise.resolve([])),
    [itemProjectId],
  );
  const { data: allMembers } = useAsync(() => listMembers(), []);
  const { data: currentUser } = useAsync(() => getCurrentUser(), []);
  const { data: agents } = useAsync(() => listAgents(), []);
  const {
    data: allAgentAssignments,
    reload: reloadAgentAssignments,
  } = useAsync(() => listAgentAssignments(), []);

  const {
    data: subItems,
    reload: reloadSubItems,
  } = useAsync(() => (item ? listSubItems(item.id) : Promise.resolve([])), [item?.id]);
  const {
    data: activity,
    reload: reloadActivity,
  } = useAsync(() => (item ? listActivity(item.id) : Promise.resolve([])), [item?.id]);
  const {
    data: comments,
    reload: reloadComments,
  } = useAsync(() => (item ? listComments(item.id) : Promise.resolve([])), [item?.id]);
  const { data: parentItem } = useAsync(
    () => (item?.parentId ? getTicket(item.parentId) : Promise.resolve(undefined)),
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
    () => (item ? listTicketProposals(item.id, 'proposed') : Promise.resolve([])),
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
        if (p.status === 'executed') seenExecutedProposalIdsRef.current.add(p.id);
      }
      return;
    }
    let shouldReload = false;
    for (const p of ticketProposals) {
      if (p.status === 'executed' && !seenExecutedProposalIdsRef.current.has(p.id)) {
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
  const [commentDraft, setCommentDraft] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [createSubOpen, setCreateSubOpen] = useState(false);
  // Stable focus target for handlePostComment below — see its own comment.
  const commentFormRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (item) {
      setTitleDraft(item.title);
      setDescDraft(item.description);
    }
    // Only reset drafts when a *different* item loads, not on every reload after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

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

  const membersById = useMemo(() => new Map((allMembers ?? []).map((m) => [m.id, m])), [allMembers]);
  const agentsById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const statesById = useMemo(() => new Map((states ?? []).map((s) => [s.id, s])), [states]);
  // `project` can still be undefined here — these memos run on every render,
  // including the ones before stillLoadingCritical/the `!project` guard
  // below have had a chance to bail out (React hooks must run
  // unconditionally, so nothing above this point can be gated on `project`
  // being resolved yet).
  const projectMembers = useMemo(
    () => (project ? (allMembers ?? []).filter((m) => project.memberIds.includes(m.id)) : []),
    [allMembers, project],
  );
  // Agents are scoped to a project the same way project membership scopes
  // humans: workspace-wide agents (scopeProjectIds: []) plus any explicitly
  // scoped to this project.
  const projectAgents = useMemo(
    () =>
      project
        ? (agents ?? []).filter(
            (a) => a.isActive && (a.scopeProjectIds.length === 0 || a.scopeProjectIds.includes(project.id)),
          )
        : [],
    [agents, project],
  );

  // An assignee id (or activity/comment author id) may resolve against a
  // human member or an agent — both live in the same id space. Centralizing
  // this here means the Activity feed, Comments feed, and assignee avatar
  // stack all agree on how to render "who did this" without branching logic
  // duplicated three times.
  function resolveActor(id: string): { name: string; color: string; shape: 'circle' | 'square'; model?: string } {
    const member = membersById.get(id);
    if (member) return { name: member.displayName, color: member.avatarColor, shape: 'circle' };
    const agent = agentsById.get(id);
    if (agent) return { name: agent.name, color: agent.avatarColor, shape: 'square', model: agent.model };
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
    Boolean(item && (states === undefined || activity === undefined || (needsProjectFetch && projectFetchLoading)));

  if (stillLoadingCritical) {
    const sidebarLabels = [
      'State',
      'Assignees',
      'Priority',
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
          isDrawer ? 'flex h-full flex-col overflow-y-auto' : 'mx-auto flex max-w-[1400px] flex-col md:flex-row'
        }
      >
        <Skeleton className={clsx('min-w-0 flex-1', !isDrawer && 'md:border-r md:border-border')}>
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
            <Skeleton.Block height="2rem" width="9.5rem" rounded="rounded-[var(--radius-sm)]" />
            <Skeleton.Block height="2rem" width="7rem" rounded="rounded-[var(--radius-sm)]" />
            <Skeleton.Block height="2rem" width="6rem" rounded="rounded-[var(--radius-sm)]" />
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
            !isDrawer && 'md:w-[300px] md:self-start md:border-t-0 md:px-5 md:py-6',
          )}
        >
          {sidebarLabels.map((label, index) => (
            <div key={label} className="flex items-center gap-3 py-2">
              <span className="w-[104px] shrink-0 text-xs text-text-muted">{label}</span>
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
  const currentWorkstream = (workstreams ?? []).find((m) => m.id === item.workstreamId);
  const currentSprint = (sprints ?? []).find((c) => c.id === item.sprintId);
  const creator = membersById.get(item.createdById);
  const assignedActors = item.assigneeIds
    .map((id) => (membersById.has(id) || agentsById.has(id) ? resolveActor(id) : null))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  const itemAgentAssignments = (allAgentAssignments ?? []).filter(
    (a) => a.ticketId === item.id && item.assigneeIds.includes(a.agentId),
  );
  const itemLabels = (labels ?? []).filter((l) => item.labelIds.includes(l.id));
  const itemLinks = item.links ?? [];
  const estimateSystem = project.estimate;
  const subItemsList = subItems ?? [];
  const doneSubItems = subItemsList.filter((c) => statesById.get(c.stateId)?.group === 'completed').length;
  const subItemsProgress = subItemsList.length > 0 ? Math.round((doneSubItems / subItemsList.length) * 100) : 0;

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
  }

  async function saveDescription() {
    if (!item) return;
    if (descDraft === item.description) return;
    await updateTicket(item.id, { description: descDraft });
    reloadItem();
  }

  async function handleSubItemCreated(newItem: Ticket) {
    if (!item) return;
    await updateTicket(newItem.id, { parentId: item.id });
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
    if (!item || !commentDraft.trim() || postingComment) return;
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
      await addComment(item.id, commentDraft.trim());
      setCommentDraft('');
      reloadComments();
      reloadActivity();
    } finally {
      setPostingComment(false);
    }
  }

  function handleDelete() {
    if (!item) return;
    if (!window.confirm(`Delete ${item.identifier}? This can't be undone.`)) return;
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

  return (
    <div
      className={
        isDrawer ? 'flex h-full flex-col overflow-y-auto' : 'mx-auto flex max-w-[1400px] flex-col md:flex-row'
      }
    >
      <div className={clsx('min-w-0 flex-1', !isDrawer && 'md:border-r md:border-border')}>
        {/* Breadcrumb */}
        <div className="flex items-center justify-between border-b border-border px-6 py-3 md:px-8">
          {isDrawer ? (
            <div className="flex min-w-0 items-center gap-1.5 text-sm text-text-secondary">
              <span className="shrink-0 font-mono text-text">{item.identifier}</span>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 text-sm text-text-secondary">
              <Link to={`/projects/${projectId}/tickets`} className="truncate hover:text-text">
                {project.name}
              </Link>
              <IconChevronRight size={14} className="shrink-0 text-text-muted" />
              <Link to={`/projects/${projectId}/tickets`} className="shrink-0 hover:text-text">
                Tickets
              </Link>
              <IconChevronRight size={14} className="shrink-0 text-text-muted" />
              <span className="shrink-0 font-mono text-text">{item.identifier}</span>
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
            className="-mx-2 w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 py-1 font-display text-xl font-semibold text-text outline-none focus:border-border-strong focus:bg-surface-2"
          />
        </div>

        {/* Description */}
        <div className="mt-2 px-6 md:px-8">
          <textarea
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={saveDescription}
            placeholder="Add description…"
            rows={4}
            className="-mx-2 w-full resize-y rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 py-1.5 text-sm text-text-secondary outline-none focus:border-border-strong focus:bg-surface-2"
          />
        </div>

        {/* Action row */}
        <div className="mt-4 flex flex-wrap items-center gap-2 px-6 md:px-8">
          <Button variant="secondary" size="sm" onClick={() => setCreateSubOpen(true)}>
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
          <Button variant="secondary" size="sm" disabled title="Coming soon">
            <Paperclip size={14} /> Attach
            <Badge tone="neutral" className="px-1.5 py-0 text-[10px] leading-4">
              Soon
            </Badge>
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
                <IconButton label={`Remove link ${link.label}`} onClick={() => handleRemoveLink(link.id)}>
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
                    <span className="shrink-0 font-mono text-xs text-text-muted">{child.identifier}</span>
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
          <h3 className="mb-2 font-display text-sm font-medium text-text">Activity</h3>
          <div className="space-y-3">
            {(activity ?? []).length === 0 && <p className="text-sm text-text-muted">No activity yet.</p>}
            {(activity ?? []).map((a) => {
              const actor = resolveActor(a.actorId);
              return (
                <div key={a.id} className="flex items-start gap-2 text-sm">
                  <Avatar name={actor.name} color={actor.color} shape={actor.shape} size={22} />
                  <div className="min-w-0">
                    <span className="text-text">{actor.shape === 'square' ? agentLabel(actor.name) : actor.name}</span>{' '}
                    <span className="text-text-secondary">{a.detail}</span>
                  </div>
                  <span className="ml-auto shrink-0 text-xs text-text-muted">
                    {formatRelativeTime(a.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

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
          <h3 className="mb-2 font-display text-sm font-medium text-text">Comments</h3>
          <div className="space-y-4">
            {(comments ?? []).map((c) => {
              const author = resolveActor(c.authorId);
              return (
                <div key={c.id} className="flex gap-2.5">
                  <Avatar name={author.name} color={author.color} shape={author.shape} size={26} />
                  <div
                    className={clsx(
                      'min-w-0 flex-1 rounded-[var(--radius)] border border-border px-3 py-2',
                      author.model ? 'bg-accent-soft-bg/40' : 'bg-surface',
                    )}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-sm font-medium text-text">
                        {author.shape === 'square' ? agentLabel(author.name) : author.name}
                      </span>
                      {author.model && (
                        <Badge tone="info" className="px-1.5 py-0 text-[10px] leading-4">
                          {author.model}
                        </Badge>
                      )}
                      <span className="text-xs text-text-muted">{formatRelativeTime(c.createdAt)}</span>
                    </div>
                    {author.model ? (
                      // Agent-authored comments are the one case where bodyHtml
                      // genuinely is HTML: proposals.service.ts builds it with
                      // buildCopilotCommentHtml, which escapes the display name
                      // and the model's body first and only ever wraps them in a
                      // fixed <p>/<em> template (waypoint-backend/src/lib/commentHtml.ts)
                      // — no path from model output to an unescaped tag. Human
                      // comments below never go through that builder, which is
                      // why they render as plain text instead of trusting this.
                      <div
                        className="prose-comment text-sm text-text-secondary [&_p]:m-0"
                        dangerouslySetInnerHTML={{ __html: c.bodyHtml }}
                      />
                    ) : (
                      // The textarea only ever collects plain text, so this
                      // renders bodyHtml as plain text too — no HTML parsing, no
                      // script/img/onerror execution. React escapes {c.bodyHtml}
                      // as a text node the same way it would any other JSX child.
                      <div className="whitespace-pre-wrap text-sm text-text-secondary">
                        {c.bodyHtml}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex gap-2.5">
            <Avatar name={currentUser?.displayName ?? 'Me'} color={currentUser?.avatarColor} size={26} />
            <div ref={commentFormRef} tabIndex={-1} className="min-w-0 flex-1 outline-none">
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Leave a comment…"
                rows={3}
                className="w-full resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!commentDraft.trim() || postingComment}
                  onClick={handlePostComment}
                >
                  {postingComment ? 'Posting…' : 'Comment'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Properties panel */}
      <aside
        className={clsx(
          'w-full shrink-0 border-t border-border px-6 py-5',
          !isDrawer && 'md:w-[300px] md:self-start md:border-t-0 md:px-5 md:py-6',
        )}
      >
        <PropertyRow label="State">
          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
                {currentState && <StateIcon state={currentState} />}
                <span className="truncate">{currentState?.name ?? 'No state'}</span>
                <IconChevron size={13} className="ml-auto shrink-0 text-text-muted" />
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
                    {s.id === item.stateId && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
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
                  <div key={assignment.id} className="flex h-8 items-center gap-2 px-2 text-sm">
                    <Avatar name={agent.name} color={agent.avatarColor} shape="square" size={20} />
                    <span className="truncate text-text">{agentLabel(agent.name)}</span>
                    <AgentStatusBadge status={assignment.status} className="ml-auto" />
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
                <IconChevron size={13} className="ml-auto shrink-0 text-text-muted" />
              </button>
            )}
          >
            {() => (
              <div className={PANEL_CLASS}>
                {projectMembers.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-text-muted">No project members.</p>
                )}
                {projectMembers.map((m) => {
                  const checked = item.assigneeIds.includes(m.id);
                  return (
                    <button key={m.id} type="button" onClick={() => toggleAssignee(m.id)} className={OPTION_CLASS}>
                      <Avatar name={m.displayName} color={m.avatarColor} size={20} />
                      <span className="truncate">{m.displayName}</span>
                      {checked && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
                    </button>
                  );
                })}
                <div className="my-1 h-px bg-border" />
                <p className="px-2 py-1 font-mono text-[10px] tracking-wide text-text-muted uppercase">Agents</p>
                {projectAgents.map((a) => {
                  const checked = item.assigneeIds.includes(a.id);
                  const assignment = itemAgentAssignments.find((x) => x.agentId === a.id);
                  return (
                    <button key={a.id} type="button" onClick={() => toggleAgent(a.id)} className={OPTION_CLASS}>
                      <Avatar name={a.name} color={a.avatarColor} shape="square" size={20} />
                      <span className="truncate">
                        {agentLabel(a.name)} <span className="text-text-muted">— {a.model}</span>
                      </span>
                      {assignment && (
                        <Dot
                          color={AGENT_STATUS_CONFIG[assignment.status].dot}
                          className={clsx('ml-auto', assignment.status === 'running' && 'animate-pulse')}
                        />
                      )}
                      {checked && <IconCheck size={14} className="shrink-0 text-accent" />}
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
                <span className="truncate">{PRIORITY_LABEL[item.priority]}</span>
                <IconChevron size={13} className="ml-auto shrink-0 text-text-muted" />
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
                    {p === item.priority && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
                  </button>
                ))}
              </div>
            )}
          </Dropdown>
        </PropertyRow>

        {estimateSystem && (
          <PropertyRow label="Estimate">
            <Dropdown
              trigger={(toggle) => (
                <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
                  <Ruler size={14} className="shrink-0 text-text-muted" />
                  <span className="truncate">{item.estimateValue ?? 'No estimate'}</span>
                  <IconChevron size={13} className="ml-auto shrink-0 text-text-muted" />
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
                    <span className="truncate text-text-secondary">No estimate</span>
                    {!item.estimateValue && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
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
                      {item.estimateValue === v && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
                    </button>
                  ))}
                </div>
              )}
            </Dropdown>
          </PropertyRow>
        )}

        <PropertyRow label="Created by">
          <div className="flex h-8 items-center gap-2 px-2 text-sm text-text">
            <Avatar name={creator?.displayName ?? 'Unknown'} color={creator?.avatarColor} size={20} />
            <span className="truncate">{creator?.displayName ?? 'Unknown'}</span>
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
                <span className="truncate">{currentWorkstream?.name ?? 'No workstream'}</span>
                <IconChevron size={13} className="ml-auto shrink-0 text-text-muted" />
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
                  <span className="truncate text-text-secondary">No workstream</span>
                  {!item.workstreamId && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
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
                    {item.workstreamId === m.id && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
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
                <span className="truncate">{currentSprint?.name ?? 'No sprint'}</span>
                <IconChevron size={13} className="ml-auto shrink-0 text-text-muted" />
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
                  <span className="truncate text-text-secondary">No sprint</span>
                  {!item.sprintId && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
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
                    {item.sprintId === c.id && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
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
                <span className="shrink-0 font-mono text-xs text-text-muted">{parentItem.identifier}</span>
                <span className="truncate">{parentItem.title}</span>
              </Link>
              <IconButton label="Clear parent" onClick={() => patchItem({ parentId: null })} className="ml-auto">
                <IconX size={13} />
              </IconButton>
            </div>
          ) : (
            <div className="flex h-8 items-center px-2 text-sm text-text-muted">None</div>
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
                <IconChevron size={13} className="ml-auto shrink-0 text-text-muted" />
              </button>
            )}
          >
            {() => (
              <div className={PANEL_CLASS}>
                {(labels ?? []).length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-text-muted">No labels in this project.</p>
                )}
                {(labels ?? []).map((l) => {
                  const checked = item.labelIds.includes(l.id);
                  return (
                    <button key={l.id} type="button" onClick={() => toggleLabel(l.id)} className={OPTION_CLASS}>
                      <Dot color={l.color} />
                      <span className="truncate">{l.name}</span>
                      {checked && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
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
