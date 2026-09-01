import { useState } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowRight, Check } from 'lucide-react';
import type { CopilotProposal, CopilotProposalKind, Priority } from '@/types/entities';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PriorityIcon, PRIORITY_LABEL } from './PriorityIcon';

// Ported 1:1 from the approved mockup (docs/qa/copilot-write-approval-mockup.html)
// into this app's Tailwind + CSS-var conventions. The invariant the visuals
// carry: a card shows names and colors (from the propose-time snapshot),
// never bare ids; nothing executes until Approve; a resolved card replaces
// its buttons with a resolution note (unmounted, not disabled — a resolved
// proposal can never be executed twice from the UI).

const KIND_LABELS: Record<CopilotProposalKind, string> = {
  comment: 'Proposed change · Comment',
  state_change: 'Proposed change · State',
  assignee_change: 'Proposed change · Assignee',
  priority_change: 'Proposed change · Priority',
  create_work_item: 'Proposed change · New ticket',
};

function StatusBadge({ status }: { status: CopilotProposal['status'] }) {
  const base = 'rounded-full px-2 py-0.5 text-[10.5px] font-semibold whitespace-nowrap';
  switch (status) {
    case 'proposed':
      return (
        <span className={clsx(base, 'border border-border-strong bg-surface-2 text-text-secondary')}>
          Pending review
        </span>
      );
    case 'executing':
      return <span className={clsx(base, 'bg-surface-2 text-text-secondary')}>Applying…</span>;
    case 'executed':
      return <span className={clsx(base, 'bg-success-bg text-success')}>Applied ✓</span>;
    case 'stale':
      return <span className={clsx(base, 'bg-warning-bg text-warning')}>Stale</span>;
    case 'expired':
      return <span className={clsx(base, 'bg-surface-2 text-text-muted')}>Expired</span>;
    case 'rejected':
    case 'superseded':
    default:
      return <span className={clsx(base, 'bg-surface-2 text-text-muted')}>Dismissed</span>;
  }
}

function TicketLine({ identifier, title }: { identifier?: string; title?: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="rounded border border-border bg-surface-2 px-1.5 py-px font-mono text-[11.5px] font-semibold text-text-secondary">
        {identifier ?? '—'}
      </span>
      <span className="leading-snug font-semibold">{title ?? ''}</span>
    </div>
  );
}

function StateChip({
  name,
  color,
  highlight,
}: {
  name?: string;
  color?: string | null;
  highlight?: boolean;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border bg-surface px-2.5 py-1 text-[12.5px] font-semibold',
        highlight ? 'border-success' : 'border-border-strong',
      )}
    >
      <span
        className="inline-block size-[9px] shrink-0 rounded-full"
        style={{ background: color ?? 'var(--text-muted)' }}
      />
      {name ?? '—'}
    </span>
  );
}

function PriorityChip({ priority }: { priority?: Priority }) {
  if (!priority) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-[12.5px] font-semibold">
      <PriorityIcon priority={priority} size={13} />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

// The disclosure prefix is server-computed from the real display name;
// pulling that name back out just feeds the avatar initials, so a
// non-matching format degrades to "You" instead of anything wrong.
function displayNameFromDisclosure(disclosureText: string): string {
  const match = /—\s*(.+?)[’']s agent/.exec(disclosureText);
  return match?.[1] ?? 'You';
}

function ProposalBody({ proposal }: { proposal: CopilotProposal }) {
  const { kind, payload, snapshot, disclosureText } = proposal;

  if (kind === 'create_work_item') {
    return (
      <>
        <div className="flex items-baseline gap-2 text-[13px]">
          <span className="rounded border border-border bg-surface-2 px-1.5 py-px font-mono text-[11.5px] font-semibold text-text-secondary">
            {snapshot.projectIdentifier ?? '—'}
          </span>
          <span className="text-text-secondary">New ticket in {snapshot.projectName ?? 'project'}</span>
        </div>
        <div className="text-[13px] leading-snug font-semibold">{payload.title}</div>
        {/* Plain text node — a model-authored description must never reach
            dangerouslySetInnerHTML. */}
        {payload.description ? (
          <div className="rounded-[var(--radius-sm)] border border-border bg-bg-inset px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">
            {payload.description}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <StateChip name={snapshot.stateName} color={snapshot.stateColor} />
          <PriorityChip priority={payload.priority} />
          {payload.dueDate ? (
            <span className="inline-flex items-center rounded-full border border-border-strong bg-surface px-2.5 py-1 text-[12.5px] font-semibold">
              Due {payload.dueDate}
            </span>
          ) : null}
        </div>
        {snapshot.assigneeNames && snapshot.assigneeNames.length > 0 ? (
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-text-muted">Assignees:</span>
            {snapshot.assigneeNames.join(', ')}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <TicketLine identifier={snapshot.identifier} title={snapshot.title} />
      {kind === 'state_change' && (
        <div className="flex flex-wrap items-center gap-2">
          <StateChip name={snapshot.fromStateName} color={snapshot.fromStateColor} />
          <ArrowRight size={14} className="text-text-muted" />
          <StateChip name={snapshot.toStateName} color={snapshot.toStateColor} highlight />
        </div>
      )}
      {kind === 'priority_change' && (
        <div className="flex flex-wrap items-center gap-2">
          <PriorityChip priority={snapshot.fromPriority} />
          <ArrowRight size={14} className="text-text-muted" />
          <PriorityChip priority={payload.priority} />
        </div>
      )}
      {kind === 'comment' && (
        <>
          {/* PLAIN REACT TEXT NODES on purpose — the body is model-authored
              text; rendering it through any HTML path (even the markdown
              renderer) is more surface than a comment preview needs. */}
          <div className="rounded-[var(--radius-sm)] border border-border bg-bg-inset px-3 py-2.5 text-[13px] leading-relaxed">
            <em className="text-text-secondary">{disclosureText}</em>
            {payload.body}
          </div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-text-secondary">
            <Avatar name={displayNameFromDisclosure(disclosureText)} size={16} />
            Posted as you
          </span>
        </>
      )}
      {kind === 'assignee_change' && (
        <div className="flex items-center gap-2 text-[13px]">
          <Avatar name={snapshot.assigneeName ?? '?'} size={22} />
          <span>
            {payload.action === 'remove' ? 'Remove ' : 'Assign '}
            <b>{snapshot.assigneeName}</b>
          </span>
          <span className="text-xs text-text-muted">
            {/* The TICKET's current assignment, not the proposed person's —
                QA caught the earlier wasAssigned-based copy reading
                "currently unassigned" on a ticket that had an assignee,
                misleading exactly the person deciding whether to approve.
                currentAssigneeNames ships in the snapshot from propose
                time; older proposals without it fall back to saying
                nothing rather than something wrong. */}
            {snapshot.currentAssigneeNames
              ? snapshot.currentAssigneeNames.length > 0
                ? `· currently: ${snapshot.currentAssigneeNames.join(', ')}`
                : '· currently unassigned'
              : null}
          </span>
        </div>
      )}
    </>
  );
}

function resolutionNote(proposal: CopilotProposal): { ok: boolean; text: string } {
  const { kind, status } = proposal;
  if (status === 'executed') {
    switch (kind) {
      case 'comment':
        return { ok: true, text: 'Applied — comment posted' };
      case 'state_change':
        return { ok: true, text: `Applied — moved to ${proposal.snapshot.toStateName ?? 'the new state'}` };
      case 'priority_change':
        return {
          ok: true,
          text: `Applied — priority set to ${proposal.payload.priority ? PRIORITY_LABEL[proposal.payload.priority] : 'the new value'}`,
        };
      case 'assignee_change':
        return {
          ok: true,
          text:
            proposal.payload.action === 'remove'
              ? `Applied — ${proposal.snapshot.assigneeName ?? 'assignee'} removed`
              : `Applied — ${proposal.snapshot.assigneeName ?? 'assignee'} assigned`,
        };
      case 'create_work_item':
      default:
        return { ok: true, text: 'Applied — ticket created' };
    }
  }
  if (status === 'expired') return { ok: false, text: 'Expired — nothing changed' };
  return {
    ok: false,
    text: kind === 'comment' ? 'Dismissed, nothing posted' : 'Dismissed, nothing changed',
  };
}

/**
 * One approval card in the Copilot transcript. `shrink-0` on the root is
 * LOAD-BEARING: the transcript is a fixed-height flex column, and the
 * card's own overflow-hidden zeroes its automatic flex minimum size —
 * without shrink-0 every card collapses to a ~2px sliver once the
 * transcript overflows, while plain text bubbles (visible overflow)
 * survive. Found and fixed in the mockup; message bubbles are unaffected
 * and stay as they are.
 */
export function CopilotProposalCard({
  proposal,
  onApprove,
  onReject,
}: {
  proposal: CopilotProposal;
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string) => Promise<unknown>;
}) {
  // Disables both buttons while either POST is in flight — the backend's
  // claim UPDATE already makes a double-approve harmless, but the UI
  // shouldn't invite one.
  const [acting, setActing] = useState(false);

  async function act(fn: (id: string) => Promise<unknown>) {
    setActing(true);
    try {
      await fn(proposal.id);
    } finally {
      // The card re-renders from the patched proposal prop; on a resolved
      // outcome this footer unmounts entirely, so re-enabling here only
      // matters when the POST failed and the card stays pending.
      setActing(false);
    }
  }

  const { status } = proposal;
  const isPending = status === 'proposed';
  const isStale = status === 'stale';
  const resolved =
    status === 'executed' || status === 'rejected' || status === 'superseded' || status === 'expired';
  const note = resolved ? resolutionNote(proposal) : null;

  return (
    <div
      className={clsx(
        'w-full shrink-0 self-start overflow-hidden rounded-[var(--radius)] border bg-surface',
        status === 'executed' ? 'border-success' : 'border-border-strong',
        (status === 'rejected' || status === 'superseded' || status === 'expired') && 'opacity-70',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-inset px-3 py-2">
        <span className="text-[10.5px] font-bold tracking-wider text-text-secondary uppercase">
          {KIND_LABELS[proposal.kind]}
        </span>
        <StatusBadge status={status} />
      </div>

      <div className="flex flex-col gap-2.5 p-3">
        <ProposalBody proposal={proposal} />
        {isStale && (
          <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-warning bg-warning-bg px-2.5 py-2 text-[12.5px] leading-snug font-medium text-warning">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{proposal.statusReason ?? 'This proposal is no longer applicable.'}</span>
          </div>
        )}
      </div>

      {isPending && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2.5">
          <span className="text-[10.5px] leading-tight text-text-muted">
            Executes once on approve · expires in 24h
          </span>
          <div className="flex shrink-0 gap-2">
            <Button size="xs" variant="secondary" disabled={acting} onClick={() => act(onReject)}>
              Reject
            </Button>
            <Button size="xs" variant="primary" disabled={acting} onClick={() => act(onApprove)}>
              Approve
            </Button>
          </div>
        </div>
      )}

      {isStale && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2.5">
          <span className="text-[10.5px] leading-tight text-text-muted">
            Blocked — what's shown above no longer matches the ticket
          </span>
          <div className="flex shrink-0 gap-2">
            <Button size="xs" variant="secondary" disabled={acting} onClick={() => act(onReject)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {note && (
        <div
          className={clsx(
            'flex items-center gap-1.5 border-t border-border px-3 py-2.5 text-xs font-semibold',
            note.ok ? 'bg-success-bg text-success' : 'text-text-muted',
          )}
        >
          {note.ok ? <Check size={13} /> : <span aria-hidden>—</span>}
          {note.text}
        </div>
      )}
    </div>
  );
}
