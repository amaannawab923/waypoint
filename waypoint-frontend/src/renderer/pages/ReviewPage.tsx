import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { clsx } from 'clsx';
import { IconBot, IconFolder, IconFilter, IconChevron, IconCheck, IconReview } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { useReviewQueue } from '@/lib/useReviewQueue';
import {
  listAgents,
  listProjects,
  getReviewHealthStats,
  bulkApproveProposals,
  bulkRejectProposals,
  type ReviewQueueSegment,
  type BulkProposalResult,
  type ReviewHealthStats,
} from '@/data/api';
import {
  approveProposal,
  rejectProposal,
  updateProposals,
} from '@/lib/proposalStore';
import { CopilotProposalCard } from '@/components/domain/CopilotProposalCard';
import { Popover } from '@/pages/tickets/Popover';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { registerActiveSelectableView } from '@/lib/useActiveSelectableView';
import type { ProposalKind } from '@/types/entities';

// W4.3 (architecture §4.4) — three segments, tab-style, each a different
// slice of the same `proposals` table (§4.4's ruling: "Blocked" projects
// agent_runs into the same card shape rather than becoming a second state
// machine — see reviewQueue.routes.ts).
const SEGMENTS: { key: ReviewQueueSegment; label: string }[] = [
  { key: 'proposed', label: 'Waiting on you' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'recent', label: 'Ran overnight' },
];

// Fixed list, not derived from data — proposalKindEnum itself (§4.2), same
// source proposals.schema.ts's listReviewQueueQuerySchema validates against.
const KIND_OPTIONS: ProposalKind[] = [
  'comment',
  'state_change',
  'assignee_change',
  'priority_change',
  'create_ticket',
  'add_label',
];

const KIND_LABELS: Record<ProposalKind, string> = {
  comment: 'Comment',
  state_change: 'State change',
  assignee_change: 'Assignee change',
  priority_change: 'Priority change',
  create_ticket: 'New ticket',
  add_label: 'Add label',
};

function countLineText(segment: ReviewQueueSegment, n: number): string {
  if (segment === 'proposed') return `${n} waiting on you`;
  if (segment === 'blocked') return `${n} blocked`;
  return `${n} handled overnight, no action needed`;
}

function emptyStateFor(segment: ReviewQueueSegment): {
  title: string;
  description: string;
} {
  if (segment === 'blocked') {
    return {
      title: 'Nothing blocked',
      description:
        'When an agent run stops and asks a question, it lands here.',
    };
  }
  if (segment === 'recent') {
    return {
      title: 'Nothing resolved yet',
      description:
        'Proposals approved or rejected in the last 24 hours will show up here.',
    };
  }
  return {
    title: 'Nothing waiting',
    description:
      'When an agent wants to change something, it lands here. Nothing an agent does takes effect until you approve it.',
  };
}

function PopoverOption({
  selected,
  label,
  onClick,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm hover:bg-surface-2',
        selected ? 'text-accent' : 'text-text',
      )}
    >
      <span className="truncate">{label}</span>
      {selected && <IconCheck size={14} className="shrink-0" />}
    </button>
  );
}

/** A single-select "<label>: <value>" filter button, closing itself on pick — reusable across the toolbar's three filters. */
function FilterPopover({
  icon,
  label,
  selectedId,
  selectedName,
  onSelect,
  options,
}: {
  icon: ReactNode;
  label: string;
  selectedId: string | undefined;
  selectedName: string;
  onSelect: (id: string | undefined) => void;
  options: { id: string; name: string }[];
}) {
  const toggleRef = useRef<() => void>(() => {});
  return (
    <Popover
      trigger={({ open, toggle }) => {
        toggleRef.current = toggle;
        return (
          <Button
            variant={open ? 'secondary' : 'ghost'}
            size="sm"
            onClick={toggle}
          >
            {icon}
            {label}: {selectedName}
            <IconChevron size={13} />
          </Button>
        );
      }}
    >
      <div className="flex w-52 flex-col">
        <p className="mb-1 px-2 pt-1 text-xs font-medium tracking-wide text-text-muted uppercase">
          {label}
        </p>
        <PopoverOption
          selected={selectedId === undefined}
          label="All"
          onClick={() => {
            onSelect(undefined);
            toggleRef.current();
          }}
        />
        {options.map((opt) => (
          <PopoverOption
            key={opt.id}
            selected={selectedId === opt.id}
            label={opt.name}
            onClick={() => {
              onSelect(opt.id);
              toggleRef.current();
            }}
          />
        ))}
      </div>
    </Popover>
  );
}

function HealthStrip({
  stats,
  loading,
}: {
  stats: ReviewHealthStats | undefined;
  loading: boolean;
}) {
  if (loading && !stats) {
    return (
      <div className="h-[68px] animate-pulse rounded-[var(--radius)] border border-border bg-surface" />
    );
  }
  if (!stats) return null;

  // Accept criterion, verbatim (architecture §4.4/§4.5, W4.3): "the health
  // strip shows 'not enough decisions yet' below 10 decisions; above it,
  // both the rate and the median come from stored decision_latency_ms."
  if (stats.approvalRate == null || stats.medianDecisionMs == null) {
    return (
      <div className="rounded-[var(--radius)] border border-border bg-surface px-4 py-3.5 text-sm text-text-muted">
        Not enough decisions yet — the health strip needs at least 10 before it
        shows a rate.
      </div>
    );
  }

  const ratePct = Math.round(stats.approvalRate * 100);
  const medianSecs = Math.round(stats.medianDecisionMs / 1000);
  // Ported from the mockup's renderHealth: both conditions, not either — a
  // high approval rate alone can just mean a good agent. High rate AND
  // near-instant decisions is the rubber-stamping tell.
  const rubberStamping = ratePct >= 95 && medianSecs <= 4;

  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-x-8 gap-y-2 rounded-[var(--radius)] border px-4 py-3.5',
        rubberStamping
          ? 'border-warning bg-warning-bg'
          : 'border-border bg-surface',
      )}
    >
      <div>
        <p className="font-display text-xl font-medium text-text">{ratePct}%</p>
        <p className="text-xs text-text-secondary">approved</p>
      </div>
      <div>
        <p className="font-display text-xl font-medium text-text">
          {medianSecs}s
        </p>
        <p className="text-xs text-text-secondary">median time to decide</p>
      </div>
      <div>
        <p className="font-display text-xl font-medium text-text">
          {stats.decisionCount}
        </p>
        <p className="text-xs text-text-secondary">decisions</p>
      </div>
      <p
        className={clsx(
          'min-w-[220px] flex-1 text-xs leading-snug',
          rubberStamping ? 'text-warning' : 'text-text-secondary',
        )}
      >
        {rubberStamping
          ? 'You are approving almost everything, almost instantly. That is rubber-stamping, not review — take a closer look.'
          : 'A 100% approval rate should worry you as much as 0%. Both mean the queue is not doing its job.'}
      </p>
    </div>
  );
}

export default function ReviewPage() {
  const [segment, setSegment] = useState<ReviewQueueSegment>('proposed');
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<ProposalKind | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Same fix as CopilotProposalCard.tsx's act(): "Load more" disables
  // itself (queue.loadingMore) the instant it's clicked, which force-blurs
  // the button per the HTML spec and leaks the next keystroke to
  // useGlobalKeyboardShortcuts.ts's global nav shortcuts. Focus this
  // stable wrapper — never disabled, never unmounted by the load — first.
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const { data: agents } = useAsync(() => listAgents(), []);
  const { data: projects } = useAsync(() => listProjects(), []);
  const health = useAsync(() => getReviewHealthStats(), []);

  const queue = useReviewQueue(segment, agentId, projectId, kind);

  // Any filter or segment change invalidates the current selection — a
  // checked row that just scrolled out of view under a new filter must not
  // silently stay part of a bulk action the user can no longer see.
  useEffect(() => {
    setSelected(new Set());
  }, [segment, agentId, projectId, kind]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const applyBulkResults = useCallback(
    (ids: string[], results: BulkProposalResult[]) => {
      const byId = new Map(results.map((r) => [r.id, r]));
      updateProposals(ids, (p) => {
        const r = byId.get(p.id);
        if (!r || r.status === 'not_found') return p;
        return { ...p, status: r.status, statusReason: r.statusReason };
      });
    },
    [],
  );

  const bulkApprove = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setSelected(new Set());
    const results = await bulkApproveProposals(ids);
    applyBulkResults(ids, results);
    queue.refreshCounts();
    health.reload();
  }, [selected, applyBulkResults, queue, health]);

  const bulkReject = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setSelected(new Set());
    const results = await bulkRejectProposals(ids);
    applyBulkResults(ids, results);
    queue.refreshCounts();
    health.reload();
  }, [selected, applyBulkResults, queue, health]);

  async function handleApprove(id: string) {
    const result = await approveProposal(id);
    queue.refreshCounts();
    health.reload();
    return result;
  }

  async function handleReject(id: string) {
    const result = await rejectProposal(id);
    queue.refreshCounts();
    health.reload();
    return result;
  }

  // W4.3 accept criterion: `e`/`r` bulk-approve/reject the current
  // selection, scoped to this screen — a listener added in an effect that's
  // torn down on unmount (not a document-wide handler some other screen's
  // code can trigger), guarded on typing targets and modifier keys the same
  // way the mockup's own keydown handler is.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (selected.size === 0) return;
      if (e.key === 'e') {
        e.preventDefault();
        bulkApprove();
      } else if (e.key === 'r') {
        e.preventDefault();
        bulkReject();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selected, bulkApprove, bulkReject]);

  // W5.4: registers this screen as the app-shell keyboard layer's "active
  // selectable view" so ⌘A (useGlobalKeyboardShortcuts.ts) can reach it —
  // purely additive, doesn't touch the e/r effect above. Only the
  // 'proposed' segment renders checkboxes at all (see `showCheckboxes`
  // below), so selectAll no-ops on the other two segments rather than
  // selecting proposals with no checkbox on screen to reflect it.
  const selectAllVisible = useCallback(() => {
    if (segment !== 'proposed') return;
    setSelected(new Set(queue.proposals.map((p) => p.id)));
  }, [segment, queue.proposals]);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);
  useEffect(() => {
    return registerActiveSelectableView({
      selectAll: selectAllVisible,
      clear: clearSelection,
    });
  }, [selectAllVisible, clearSelection]);

  const agentOptions = useMemo(
    () => (agents ?? []).map((a) => ({ id: a.id, name: a.name })),
    [agents],
  );
  const projectOptions = useMemo(
    () => (projects ?? []).map((p) => ({ id: p.id, name: p.name })),
    [projects],
  );
  const kindOptions = useMemo(
    () => KIND_OPTIONS.map((k) => ({ id: k, name: KIND_LABELS[k] })),
    [],
  );

  const selectedAgentName =
    agentOptions.find((a) => a.id === agentId)?.name ?? 'All';
  const selectedProjectName =
    projectOptions.find((p) => p.id === projectId)?.name ?? 'All';
  const selectedKindName = kind ? KIND_LABELS[kind] : 'All';

  const empty = emptyStateFor(segment);
  const showCheckboxes = segment === 'proposed';

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <div className="mb-4">
        <h1 className="font-display text-xl font-medium text-text">Review</h1>
        <p className="text-sm text-text-secondary">
          Every pending proposal from every agent, across every project — what
          would change, and Approve or Reject. Agents never write directly;
          approving is the only thing that mutates anything.
        </p>
      </div>

      <div
        className="mb-4 flex items-center gap-1 rounded-[var(--radius-sm)] border border-border-strong p-0.5"
        role="tablist"
      >
        {SEGMENTS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={segment === s.key}
            onClick={() => setSegment(s.key)}
            className={clsx(
              'flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] px-3 text-sm font-medium transition-colors',
              segment === s.key
                ? 'bg-accent text-on-accent'
                : 'text-text-secondary hover:bg-surface-2 hover:text-text',
            )}
          >
            {s.label}
            <span className="font-mono text-xs opacity-70">
              {queue.counts[s.key]}
            </span>
          </button>
        ))}
      </div>

      <div className="mb-4">
        <HealthStrip stats={health.data} loading={health.loading} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterPopover
          icon={<IconBot size={14} />}
          label="Agent"
          selectedId={agentId}
          selectedName={selectedAgentName}
          onSelect={setAgentId}
          options={agentOptions}
        />
        <FilterPopover
          icon={<IconFolder size={14} />}
          label="Project"
          selectedId={projectId}
          selectedName={selectedProjectName}
          onSelect={setProjectId}
          options={projectOptions}
        />
        <FilterPopover
          icon={<IconFilter size={14} />}
          label="Kind"
          selectedId={kind}
          selectedName={selectedKindName}
          onSelect={(id) => setKind(id as ProposalKind | undefined)}
          options={kindOptions}
        />
      </div>

      <p className="mb-3 text-xs font-medium text-text-muted">
        {countLineText(segment, queue.proposals.length)}
      </p>

      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-[var(--radius)] border border-accent bg-accent-soft-bg px-3 py-2">
          <span className="text-sm font-medium text-accent-soft-text">
            {selected.size} selected
          </span>
          <Button size="xs" variant="primary" onClick={bulkApprove}>
            Approve selected
          </Button>
          <Button size="xs" variant="secondary" onClick={bulkReject}>
            Reject selected
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto cursor-pointer text-xs text-text-secondary hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      {(() => {
        if (queue.loading && queue.proposals.length === 0)
          return <SkeletonListRows rows={5} />;
        if (queue.proposals.length === 0) {
          return (
            <EmptyState
              icon={<IconReview size={28} />}
              title={empty.title}
              description={empty.description}
            />
          );
        }
        return (
          <div className="flex flex-col gap-3">
            {queue.proposals.map((p) => (
              <div key={p.id} className="flex items-start gap-2.5">
                {showCheckboxes && (
                  <input
                    type="checkbox"
                    className="mt-3.5 shrink-0 accent-[var(--accent)]"
                    checked={selected.has(p.id)}
                    onChange={() => toggleSelected(p.id)}
                    aria-label={`Select proposal ${p.id}`}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <CopilotProposalCard
                    proposal={p}
                    onApprove={handleApprove}
                    onReject={handleReject}
                  />
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {queue.hasMore && (
        <div
          ref={loadMoreRef}
          tabIndex={-1}
          data-shortcut-guard
          className="mt-4 flex justify-center outline-none"
        >
          <Button
            variant="secondary"
            size="sm"
            disabled={queue.loadingMore}
            onClick={() => {
              loadMoreRef.current?.focus();
              queue.loadMore();
            }}
          >
            {queue.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
