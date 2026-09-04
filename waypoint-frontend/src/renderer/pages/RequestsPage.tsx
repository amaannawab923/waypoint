import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { Copy, Globe2, Link2 } from 'lucide-react';
import { IconCheck, IconInbox, IconPlus, IconX } from '@/components/icons';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import {
  convertRequestToTicket,
  createRequest,
  getCurrentUser,
  listRequestProposals,
  listRequests,
  listStates,
  listTickets,
  updateRequestStatus,
} from '@/data/api';
import { refreshProjectInStore } from '@/lib/projectsStore';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Skeleton, SkeletonListRows } from '@/components/ui/Skeleton';
import { NotWired } from '@/components/ui/NotWired';
import { CopilotProposalCard } from '@/components/domain/CopilotProposalCard';
import { STATE_GROUP_ORDER } from '@/components/domain/StateIcon';
import { PRIORITY_LABEL, PRIORITY_ORDER } from '@/components/domain/PriorityIcon';
import {
  approveProposal,
  rejectProposal,
  upsertProposals,
  useAllProposals,
} from '@/lib/proposalStore';
import type { Request, RequestStatus, Priority, Ticket } from '@/types/entities';

const STATUS_TABS: { key: RequestStatus; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'declined', label: 'Declined' },
  { key: 'duplicate', label: 'Duplicate' },
];

const STATUS_TONE: Record<RequestStatus, BadgeTone> = {
  pending: 'warning',
  accepted: 'success',
  declined: 'danger',
  duplicate: 'neutral',
};

/** Local toggle switch — mirrors the one in project-settings/Features.tsx; there's no shared
 * Toggle primitive in src/components/ui/ yet. */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={
        'relative h-5 w-9 shrink-0 rounded-full transition-colors ' +
        (checked ? 'bg-accent' : 'bg-surface-2 border border-border-strong')
      }
    >
      <span
        className={
          'absolute top-0.5 size-4 rounded-full bg-[var(--on-accent)] shadow transition-transform ' +
          (checked ? 'translate-x-[18px] bg-on-accent' : 'translate-x-0.5 bg-text-muted')
        }
      />
    </button>
  );
}

export default function RequestsPage() {
  const { project } = useProject();
  const [tab, setTab] = useState<RequestStatus>('pending');
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<Priority>('none');
  const [creating, setCreating] = useState(false);

  const [publicFormEnabled, setPublicFormEnabled] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const [reviewRequest, setReviewRequest] = useState<Request | null>(null);
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewDescription, setReviewDescription] = useState('');
  const [reviewPriority, setReviewPriority] = useState<Priority>('none');
  const [reviewStateId, setReviewStateId] = useState('');
  const [converting, setConverting] = useState(false);

  const { data: requests, loading, reload } = useAsync(() => listRequests(project.id), [project.id]);
  const { data: states } = useAsync(() => listStates(project.id), [project.id]);
  const { data: tickets, reload: reloadTickets } = useAsync(() => listTickets(project.id), [project.id]);
  const { data: currentUser } = useAsync(() => getCurrentUser(), []);

  const ticketById = useMemo(() => {
    const map = new Map<string, Ticket>();
    for (const item of tickets ?? []) map.set(item.id, item);
    return map;
  }, [tickets]);

  const orderedStates = useMemo(
    () =>
      [...(states ?? [])].sort(
        (a, b) => STATE_GROUP_ORDER.indexOf(a.group) - STATE_GROUP_ORDER.indexOf(b.group) || a.sortOrder - b.sortOrder,
      ),
    [states],
  );

  const publicFormUrl = `https://waypoint.app/i/${project.identifier.toLowerCase()}`;

  const counts = useMemo(() => {
    const map: Record<RequestStatus, number> = { pending: 0, accepted: 0, declined: 0, duplicate: 0 };
    for (const r of requests ?? []) map[r.status] += 1;
    return map;
  }, [requests]);

  const filtered = useMemo(
    () => (requests ?? []).filter((r) => r.status === tab).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [requests, tab],
  );

  // Pending proposals inline on each request's row (W4.4, architecture
  // §4.4) — same shared proposalStore as the ticket-detail integration, so
  // approving here (or from a future Review screen) stays in sync
  // everywhere with no refetch.
  //
  // N+1-vs-batched: fetched per row rather than through one batched
  // endpoint. `sourceRequestId` is only ever set while a request is still
  // being triaged (schema note: "Set when the proposal originated from
  // triaging an incoming request") — once a request is accepted, declined,
  // or marked a duplicate, triage is done and a still-pending proposal
  // against it would be stale, so the rows worth checking are effectively
  // bounded to the currently active tab's `filtered` list, not this page's
  // full (unpaginated) per-project request history. That tab is usually the
  // 'pending' queue, which teams keep small by actively triaging it — a
  // handful of rows, not dozens — so one GET per visible row (mirroring the
  // ticket-detail integration's simplicity) is proportionate. If usage ever
  // shows a tab routinely rendering dozens of rows, revisit this as a single
  // batched call (e.g. `GET /requests/proposals?ids=...`) grouped by
  // request id.
  useEffect(() => {
    let cancelled = false;
    Promise.all(filtered.map((r) => listRequestProposals(r.id, 'proposed').catch(() => [])))
      .then((rows) => {
        if (!cancelled) upsertProposals(rows.flat());
        return undefined;
      })
      .catch(() => {
        // A failed inline-proposals fetch shouldn't block the requests list
        // itself — httpClient already toasted per failed call above.
      });
    return () => {
      cancelled = true;
    };
  }, [filtered]);
  const allProposals = useAllProposals();

  function openReview(request: Request) {
    if (workingId) return;
    const defaultState = orderedStates.find((s) => s.group === 'unstarted') ?? orderedStates[0];
    setReviewRequest(request);
    setReviewTitle(request.title);
    setReviewDescription(request.description);
    setReviewPriority(request.priority ?? 'none');
    setReviewStateId(defaultState?.id ?? '');
  }

  function closeReview() {
    setReviewRequest(null);
  }

  async function handleConfirmAccept() {
    if (!reviewRequest || !reviewStateId || !reviewTitle.trim() || converting) return;
    setConverting(true);
    try {
      await convertRequestToTicket(reviewRequest.id, reviewStateId, {
        title: reviewTitle.trim(),
        description: reviewDescription.trim(),
        priority: reviewPriority,
      });
      setReviewRequest(null);
      // Both the requests list (status flips to accepted) and the tickets
      // list (the newly created linked item) need refetching — otherwise
      // ticketById can't resolve the badge until an unrelated reload.
      reload();
      reloadTickets();
    } finally {
      setConverting(false);
    }
  }

  async function handleDecline(request: Request) {
    if (workingId) return;
    setWorkingId(request.id);
    try {
      await updateRequestStatus(request.id, 'declined');
      reload();
    } finally {
      setWorkingId(null);
    }
  }

  function resetCreateForm() {
    setNewTitle('');
    setNewDescription('');
    setNewPriority('none');
  }

  function closeCreateModal() {
    resetCreateForm();
    setCreateOpen(false);
  }

  async function handleCreate() {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      await createRequest({
        projectId: project.id,
        title: newTitle.trim(),
        description: newDescription.trim(),
        priority: newPriority,
        sourceName: currentUser?.displayName ?? currentUser?.fullName ?? 'You',
        sourceEmail: currentUser?.email ?? '',
      });
      resetCreateForm();
      setCreateOpen(false);
      setTab('pending');
      reload();
      // This may be the project's first request — refresh the shared
      // projects store so the sidebar's Requests entry (driven by
      // acceptsRequests || primitiveCounts.requests > 0) appears without a
      // page reload.
      refreshProjectInStore(project.id);
    } finally {
      setCreating(false);
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(publicFormUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      // Clipboard access can fail (unsupported browser, no permission) —
      // the URL is still shown in the input for manual copy.
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-text-muted uppercase">Agent-triaged queue</p>
          <h1 className="font-display text-lg font-medium text-text">Requests</h1>
          <p className="text-sm text-text-secondary">
            Work from outside the team asking to come in. The Triage Agent reviews each one against the
            repo and the existing tickets, then proposes a verdict below — approve or reject it here, and
            it shows up in Review too.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
          <IconPlus size={14} />
          New request
        </Button>
      </div>

      <div className="flex flex-col gap-2 border-b border-border px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Globe2 size={14} className="text-text-muted" />
            <div>
              <p className="text-sm font-medium text-text">Public request form</p>
              <p className="text-xs text-text-secondary">Let anyone with the link submit a request without an account.</p>
            </div>
          </div>
          <Toggle checked={publicFormEnabled} onChange={setPublicFormEnabled} />
        </div>
        {publicFormEnabled && <NotWired capability="requests.publicForm" />}
        {publicFormEnabled && (
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={publicFormUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="h-8 flex-1 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 font-mono text-xs text-text-secondary outline-none"
            />
            <Button variant="secondary" size="sm" onClick={handleCopyLink}>
              <Copy size={13} />
              {linkCopied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-b border-border px-6">
        {STATUS_TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
              tab === key ? 'border-accent text-text' : 'border-transparent text-text-secondary hover:text-text'
            }`}
          >
            {label}
            <span className="text-xs text-text-muted">{counts[key]}</span>
          </button>
        ))}
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto">
        {loading && !requests ? (
          <SkeletonListRows rows={6} />
        ) : !requests || requests.length === 0 ? (
          <EmptyState
            icon={<IconInbox size={28} />}
            title="No requests yet"
            description="Requests submitted to this project's request form will show up here."
          />
        ) : filtered.length === 0 ? (
          <EmptyState title={`No ${tab} requests`} />
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((request) => {
              const linkedItem = request.linkedTicketId ? ticketById.get(request.linkedTicketId) : undefined;
              const requestProposals = allProposals.filter((p) => p.sourceRequestId === request.id);
              return (
                <li key={request.id} className="flex items-start gap-4 px-6 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-text">{request.title}</span>
                      <Badge tone={STATUS_TONE[request.status]}>{request.status}</Badge>
                    </div>
                    <p className="mb-2 line-clamp-2 text-sm text-text-secondary">{request.description}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                      <span>
                        {request.sourceName} · {request.sourceEmail}
                      </span>
                      <span>{formatDistanceToNow(new Date(request.createdAt), { addSuffix: true })}</span>
                    </div>
                    {request.linkedTicketId && !linkedItem && (
                      <Skeleton className="mt-2 inline-flex">
                        <Skeleton.Block height="1rem" width="8rem" />
                      </Skeleton>
                    )}
                    {linkedItem && (
                      <Link
                        to={`/projects/${project.id}/tickets/${linkedItem.identifier}`}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-surface-2 px-2 py-1 text-xs font-medium text-text-secondary hover:border-accent hover:text-accent"
                      >
                        <Link2 size={12} />
                        {linkedItem.identifier} · {linkedItem.title}
                      </Link>
                    )}
                    {/* Pending proposals — no empty state: a request with
                        nothing pending renders no card at all. */}
                    {requestProposals.length > 0 && (
                      <div className="mt-3 flex flex-col gap-2">
                        {requestProposals.map((p) => (
                          <CopilotProposalCard
                            key={p.id}
                            proposal={p}
                            onApprove={approveProposal}
                            onReject={rejectProposal}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  {request.status === 'pending' && (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={workingId === request.id}
                        onClick={() => handleDecline(request)}
                      >
                        <IconX size={14} />
                        Decline
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={workingId === request.id}
                        onClick={() => openReview(request)}
                      >
                        <IconCheck size={14} />
                        Accept
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={closeCreateModal}
        title="New request"
        footer={
          <>
            <Button variant="ghost" onClick={closeCreateModal}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!newTitle.trim() || creating} onClick={handleCreate}>
              {creating ? 'Submitting…' : 'Submit request'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Title</label>
            <input
              autoFocus
              placeholder="What's the request?"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) handleCreate();
              }}
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Description</label>
            <textarea
              placeholder="Add more detail (optional)"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              rows={4}
              className="resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Priority (optional)</label>
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as Priority)}
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            >
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Modal>

      <Modal
        open={reviewRequest !== null}
        onClose={closeReview}
        title="Review before accepting"
        footer={
          <>
            <Button variant="ghost" onClick={closeReview}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!reviewTitle.trim() || !reviewStateId || converting}
              onClick={handleConfirmAccept}
            >
              {converting ? 'Creating…' : 'Create ticket'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            Adjust the details below before this request becomes a ticket.
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Title</label>
            <input
              autoFocus
              value={reviewTitle}
              onChange={(e) => setReviewTitle(e.target.value)}
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Description</label>
            <textarea
              value={reviewDescription}
              onChange={(e) => setReviewDescription(e.target.value)}
              rows={4}
              className="resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs font-medium text-text-secondary">State</label>
              <select
                value={reviewStateId}
                onChange={(e) => setReviewStateId(e.target.value)}
                className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
              >
                {orderedStates.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs font-medium text-text-secondary">Priority</label>
              <select
                value={reviewPriority}
                onChange={(e) => setReviewPriority(e.target.value as Priority)}
                className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
              >
                {PRIORITY_ORDER.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
