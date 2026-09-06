import { useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ArrowRight } from 'lucide-react';
import { approveJiraProposal, rejectJiraProposal } from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';
import { IconCheck, IconGitBranch, IconSparkles } from '@/components/icons';
import type { JiraProposal } from '@/types/jira';

// A Jira-specific sibling of CopilotProposalCard.tsx, not a reuse of it —
// that component (and the ProposalView/ProposalKind types it renders) is
// tightly coupled to real ticket UUIDs and a backend-driven claim state
// machine that doesn't exist for Jira. This mirrors its STRUCTURE and one
// specific safety pattern instead: the cardRef/tabIndex={-1}/
// data-shortcut-guard focus-guard technique (see CopilotProposalCard.tsx's
// own long comment on why — the disabled/unmounted-button force-blur
// issue), the disabled-both-buttons-while-in-flight `acting` state, and the
// resolved-state footer swap (buttons replaced by a resolution note, never
// left clickable twice).

function StatusBadge({ status }: { status: JiraProposal['status'] }) {
  const base =
    'ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold whitespace-nowrap';
  switch (status) {
    case 'proposed':
      return (
        <span
          className={clsx(
            base,
            'border border-border-strong bg-surface text-text-secondary',
          )}
        >
          Needs your approval
        </span>
      );
    case 'executing':
      return (
        <span className={clsx(base, 'bg-surface text-text-secondary')}>
          Writing…
        </span>
      );
    case 'executed':
      return (
        <span className={clsx(base, 'bg-success-bg text-success')}>
          Approved by you
        </span>
      );
    case 'rejected':
    default:
      return (
        <span className={clsx(base, 'bg-surface text-text-muted')}>
          Dismissed
        </span>
      );
  }
}

function StateChip({
  name,
  color,
  highlight,
}: {
  name: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border bg-surface px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap',
        highlight ? 'border-accent' : 'border-border-strong',
      )}
    >
      <span
        className="size-[6px] shrink-0 rounded-full"
        style={{ background: color }}
      />
      {name}
    </span>
  );
}

/**
 * The Copilot rail's proposal card for ENG-421 — a single combined
 * state-change + comment proposal (types/jira.ts's JiraProposal). Approve
 * applies both halves atomically; nothing here assumes it's the only card
 * ever rendered by a future second Jira proposal, but there is only one
 * today (see jiraApi.ts's proposalFixture).
 */
export function JiraProposalCard({
  proposal,
  onResolved,
}: {
  proposal: JiraProposal;
  onResolved: (updated: JiraProposal) => void;
}) {
  // Same "disable both while either write is in flight" rule as
  // CopilotProposalCard — the mock write is idempotent enough, but the UI
  // shouldn't invite a double-click regardless.
  const [acting, setActing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  async function act(fn: (id: string) => Promise<JiraProposal>) {
    cardRef.current?.focus();
    setActing(true);
    try {
      const updated = await fn(proposal.id);
      onResolved(updated);
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Could not resolve this proposal.',
      );
    } finally {
      setActing(false);
    }
  }

  const { status } = proposal;
  const isPending = status === 'proposed';
  const resolved = status === 'executed' || status === 'rejected';
  const mentionsList =
    proposal.commentMentions.length > 0
      ? proposal.commentMentions.join(', ')
      : 'the team';

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-shortcut-guard
      className={clsx(
        'w-full overflow-hidden rounded-[var(--radius)] border bg-surface shadow-sm outline-none',
        status === 'executed' ? 'border-success' : 'border-border-strong',
        status === 'rejected' && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-surface-2 px-3 py-2">
        <IconSparkles size={13} className="text-accent" />
        <span className="text-[10.5px] font-bold tracking-wide text-text-secondary uppercase">
          Copilot · local
        </span>
        <StatusBadge status={status} />
      </div>

      {!resolved ? (
        <>
          <div className="flex flex-col gap-2.5 p-3">
            <div className="rounded-[var(--radius-sm)] border border-dashed border-border-strong bg-bg-inset px-2.5 py-2 text-[11.5px] leading-relaxed text-text-secondary">
              <div className="flex items-center gap-1.5">
                <IconGitBranch size={12} className="shrink-0" />
                <span className="truncate font-mono font-semibold text-text">
                  {proposal.repoPath}
                </span>
              </div>
              <div className="mt-1">
                branch{' '}
                <span className="font-mono font-semibold text-text">
                  {proposal.branch}
                </span>{' '}
                · {proposal.commitCount} commit
                {proposal.commitCount === 1 ? '' : 's'}
              </div>
              <div className="mt-1">
                <b className="text-text">PR #{proposal.prNumber}</b>{' '}
                {proposal.prStatus} · &quot;closes {proposal.ticketKey}&quot;
              </div>
              <div className="mt-1.5 border-t border-border pt-1.5 text-[10.5px] text-text-muted">
                Read from your checkout by the local agent. No code left this
                machine.
              </div>
            </div>

            <div className="text-[11.5px] font-semibold text-text-muted">
              Copilot proposes, on{' '}
              <span
                className="font-mono font-semibold"
                style={{ color: proposal.ticketProjectColor }}
              >
                {proposal.ticketKey}
              </span>
              :
            </div>

            <div className="flex items-start gap-2 text-[12.5px]">
              <span className="mt-0.5 flex size-[17px] shrink-0 items-center justify-center rounded-full bg-accent-soft-bg text-[10px] font-bold text-accent-soft-text">
                1
              </span>
              <div className="flex flex-1 flex-wrap items-center gap-1.5">
                Move
                <StateChip
                  name={proposal.fromStateName}
                  color={proposal.fromStateColor}
                />
                <ArrowRight size={13} className="text-text-muted" />
                <StateChip
                  name={proposal.toStateName}
                  color={proposal.toStateColor}
                  highlight
                />
              </div>
            </div>

            <div className="flex items-start gap-2 text-[12.5px]">
              <span className="mt-0.5 flex size-[17px] shrink-0 items-center justify-center rounded-full bg-accent-soft-bg text-[10px] font-bold text-accent-soft-text">
                2
              </span>
              <div className="min-w-0 flex-1">
                Post a comment:
                {/* Plain react text node — model-authored content, same rule
                    CopilotProposalCard.tsx follows for a comment body. */}
                <div className="mt-1 border-l-2 border-border-strong pl-2 text-[11.5px] leading-relaxed text-text-secondary">
                  {proposal.commentBody}
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-jira/30 bg-jira-bg px-2.5 py-2 text-[11.5px] text-jira">
              Approving writes to the real Jira issue as <b>Max Chen</b> — your
              whole team sees it, and {mentionsList} gets notified.
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2.5">
            <span className="text-[10.5px] leading-tight text-text-muted">
              Always needs this click — earned trust never auto-applies a Jira
              write.
            </span>
            <div className="flex shrink-0 gap-2">
              <Button
                size="xs"
                variant="secondary"
                disabled={acting || !isPending}
                onClick={() => act(rejectJiraProposal)}
              >
                Reject
              </Button>
              <Button
                size="xs"
                variant="primary"
                disabled={acting || !isPending}
                onClick={() => act(approveJiraProposal)}
              >
                Approve
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div
          className={clsx(
            'flex items-start gap-2 px-3 py-3 text-[12.5px]',
            status === 'executed'
              ? 'bg-success-bg text-success'
              : 'text-text-muted',
          )}
        >
          {status === 'executed' ? (
            <>
              <IconCheck size={14} className="mt-0.5 shrink-0" />
              <div>
                <b className="block font-semibold">Written to Jira</b>
                <span>
                  {proposal.ticketKey} moved to {proposal.toStateName} and the
                  comment posted as Max Chen. Undo isn't offered — Jira has
                  already notified {mentionsList}.
                </span>
              </div>
            </>
          ) : (
            <span>Rejected — Copilot is told why on its next turn.</span>
          )}
        </div>
      )}
    </div>
  );
}
