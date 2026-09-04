import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Loader, Users } from 'lucide-react';
import { IconTrack, IconPlus } from '@/components/icons';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import {
  createWorkstream,
  listMembers,
  listWorkstreams,
  listStates,
  listTickets,
} from '@/data/api';
import { refreshProjectInStore } from '@/lib/projectsStore';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import type { Workstream } from '@/types/entities';

const STATUS_LABEL: Record<Workstream['status'], string> = {
  planned: 'Planned',
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
  dropped: 'Dropped',
};

const STATUS_TONE: Record<Workstream['status'], BadgeTone> = {
  paused: 'neutral',
  planned: 'info',
  active: 'warning',
  done: 'success',
  dropped: 'danger',
};

function formatDate(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function dateRangeLabel(workstream: Workstream): string {
  const start = formatDate(workstream.startDate);
  const target = formatDate(workstream.targetDate);
  if (!start && !target) return 'No dates set';
  if (start && target) return `${start} – ${target}`;
  return start ? `From ${start}` : `Due ${target}`;
}

export default function WorkstreamsPage() {
  const { project } = useProject();
  const navigate = useNavigate();
  const {
    data: workstreams,
    loading,
    reload,
  } = useAsync(() => listWorkstreams(project.id), [project.id]);
  const { data: tickets } = useAsync(
    () => listTickets(project.id),
    [project.id],
  );
  const { data: states } = useAsync(() => listStates(project.id), [project.id]);
  const { data: allMembers } = useAsync(() => listMembers(), []);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Same fix as CopilotProposalCard.tsx's act(): "Create workstream"
  // disables itself (submitting) while the POST is in flight.
  // Modal.tsx's own Escape/Tab handling doesn't cover this — a generic
  // dialog isn't one of useGlobalKeyboardShortcuts.ts's
  // isShortcutSuppressed exemptions ([data-ticket-drawer],
  // [data-copilot-panel], [data-shortcut-guard]) — so the force-blur mid-
  // request can still leak the next keystroke to global nav shortcuts.
  // Modal.tsx isn't ours to touch here, so this wraps just the footer
  // buttons in a local, stable, always-mounted-while-open focus target.
  const footerRef = useRef<HTMLDivElement>(null);

  const membersById = useMemo(
    () => new Map((allMembers ?? []).map((m) => [m.id, m])),
    [allMembers],
  );

  const completedStateIds = useMemo(
    () =>
      new Set(
        (states ?? []).filter((s) => s.group === 'completed').map((s) => s.id),
      ),
    [states],
  );

  const progressFor = useMemo(() => {
    return (workstreamId: string) => {
      const items = (tickets ?? []).filter(
        (i) => i.workstreamId === workstreamId,
      );
      if (items.length === 0) return null;
      const done = items.filter((i) => completedStateIds.has(i.stateId)).length;
      return Math.round((done / items.length) * 100);
    };
  }, [tickets, completedStateIds]);

  // The list never showed a raw ticket count, only a progress % — with no
  // way to sanity-check that percentage against anything without opening
  // each workstream to see its own "Tickets (N)" heading
  // (WorkstreamDetailPage.tsx). Sourced from the same already-fetched
  // `tickets` this page uses for progressFor, so no extra request.
  const ticketCountFor = useMemo(() => {
    return (workstreamId: string) =>
      (tickets ?? []).filter((i) => i.workstreamId === workstreamId).length;
  }, [tickets]);

  const stats = useMemo(() => {
    const list = workstreams ?? [];
    return {
      total: list.length,
      done: list.filter((m) => m.status === 'done').length,
      active: list.filter((m) => m.status === 'active').length,
    };
  }, [workstreams]);

  async function handleCreate() {
    if (!name.trim() || submitting) return;
    footerRef.current?.focus();
    setSubmitting(true);
    try {
      await createWorkstream(project.id, { name: name.trim() });
      setName('');
      setCreating(false);
      reload();
      // This may be the project's first workstream — refresh the shared
      // projects store so the sidebar's Workstreams entry (driven by
      // primitiveCounts.workstreams > 0) appears without a page reload.
      refreshProjectInStore(project.id);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="font-display text-lg font-medium text-text">
            Workstreams
          </h1>
          <p className="text-sm text-text-secondary">
            Not time-boxed — a standing area of {project.name} that outlives any
            one sprint.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={15} />
          Add Workstream
        </Button>
      </div>

      {!!workstreams?.length && (
        <div className="grid grid-cols-3 gap-3 border-b border-border px-6 py-4">
          <div className="rounded-[var(--radius)] border border-border bg-surface p-4">
            <IconTrack
              size={16}
              className="mb-3 text-text-muted"
              strokeWidth={2}
            />
            <p className="font-display text-2xl font-medium text-text">
              {stats.total}
            </p>
            <p className="text-xs text-text-secondary">Total workstreams</p>
          </div>
          <div className="rounded-[var(--radius)] border border-border bg-surface p-4">
            <CheckCircle2
              size={16}
              className="mb-3 text-text-muted"
              strokeWidth={2}
            />
            <p className="font-display text-2xl font-medium text-text">
              {stats.done}
            </p>
            <p className="text-xs text-text-secondary">Done</p>
          </div>
          <div className="rounded-[var(--radius)] border border-border bg-surface p-4">
            <Loader
              size={16}
              className="mb-3 text-text-muted"
              strokeWidth={2}
            />
            <p className="font-display text-2xl font-medium text-text">
              {stats.active}
            </p>
            <p className="text-xs text-text-secondary">Active</p>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto thin-scroll">
        {loading && !workstreams ? (
          <SkeletonListRows rows={6} />
        ) : !workstreams || workstreams.length === 0 ? (
          <EmptyState
            icon={<IconTrack size={28} />}
            title="No workstreams yet"
            description="Create a workstream to give a slice of work — a migration, a redesign — its own lead and status."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <IconPlus size={15} />
                Add Workstream
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {workstreams.map((workstream) => {
              const progress = progressFor(workstream.id);
              const ticketCount = ticketCountFor(workstream.id);
              const lead = workstream.leadId
                ? membersById.get(workstream.leadId)
                : undefined;
              return (
                <li key={workstream.id}>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/projects/${project.id}/workstreams/${workstream.id}`,
                      )
                    }
                    className="flex w-full items-center gap-4 px-6 py-3.5 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                      {workstream.name}
                    </span>
                    <Badge tone={STATUS_TONE[workstream.status]}>
                      {STATUS_LABEL[workstream.status]}
                    </Badge>
                    <span className="w-36 shrink-0 text-xs text-text-muted">
                      {dateRangeLabel(workstream)}
                    </span>
                    {lead ? (
                      <Avatar
                        name={lead.displayName}
                        color={lead.avatarColor}
                        size={20}
                        className="shrink-0"
                      />
                    ) : (
                      <span className="size-5 shrink-0" />
                    )}
                    <span className="flex w-14 shrink-0 items-center gap-1 text-xs text-text-muted">
                      <Users size={12} />
                      {workstream.memberIds.length}
                    </span>
                    <span className="w-16 shrink-0 text-right text-xs text-text-muted">
                      {ticketCount} ticket{ticketCount === 1 ? '' : 's'}
                    </span>
                    <div className="flex w-32 shrink-0 items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${progress ?? 0}%` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right text-xs text-text-muted">
                        {progress === null ? '—' : `${progress}%`}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Modal
        open={creating}
        onClose={() => {
          setCreating(false);
          setName('');
        }}
        title="New workstream"
        footer={
          <div
            ref={footerRef}
            tabIndex={-1}
            data-shortcut-guard
            className="flex gap-2 outline-none"
          >
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim() || submitting}
              onClick={handleCreate}
            >
              {submitting ? 'Creating…' : 'Create workstream'}
            </Button>
          </div>
        }
      >
        <input
          autoFocus
          placeholder="Workstream name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate();
          }}
          className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
        />
      </Modal>
    </div>
  );
}
