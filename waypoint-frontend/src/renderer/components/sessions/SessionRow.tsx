import { clsx } from 'clsx';
import { IconFolder, IconGitBranch } from '@/components/icons';
import { formatRelativeTime } from '@/lib/copilotSessions';
import { useHomeDir } from '@/lib/useHomeDir';
import { useTicketLabel } from '@/lib/useTicketLabel';
import type { AgentRun } from '@/types/agentRuns';
import { Badge } from '@/components/ui/Badge';
import { verdictLabel, verdictTone } from '@/lib/runVerdict';
import {
  intentView,
  MODE_TITLES,
  providerView,
  runTitle,
  runWhere,
  waitingReason,
} from './sessionStatus';
import { SessionStatusDot } from './SessionStatusPill';

/** The provider as a 13 px lettered chip, hover for the name. */
export function ProviderChip({
  providerId,
  size = 13,
}: {
  providerId: string;
  size?: number;
}) {
  const view = providerView(providerId);
  return (
    <span
      title={view.name}
      aria-label={view.name}
      className={clsx(
        'flex shrink-0 items-center justify-center rounded text-[8px] font-extrabold text-white',
        view.chipClass,
      )}
      style={{ width: size, height: size }}
    >
      {view.letter}
    </span>
  );
}

/**
 * A session started with auto-approve works without asking (W4b); the
 * mark is on the row and in the header so an unattended agent in
 * someone's files is never invisible in the list.
 */
/**
 * What a finished run concluded (W5c): `not a bug`, `fixed`… — beside the
 * status once finalize has read the report; nothing before.
 */
export function VerdictChip({
  run,
  size = 'sm',
}: {
  run: Pick<AgentRun, 'verdict'>;
  size?: 'sm' | 'md';
}) {
  if (!run.verdict) return null;
  return (
    <span data-verdict-chip className="inline-flex shrink-0">
      <Badge
        tone={verdictTone(run.verdict)}
        className={clsx(
          size === 'sm'
            ? 'px-1.5 py-0 text-[9px] leading-[14px]'
            : 'py-0 text-[10px] leading-4',
        )}
      >
        {verdictLabel(run.verdict)}
      </Badge>
    </span>
  );
}

/**
 * A dispatched run's verb and mode (W5a §1.4): `Investigate · plan`,
 * `Fix · auto`, `Session`. Beside the status, where an independent run
 * shows nothing; the auto mark alone is the independent run's.
 */
export function IntentChip({
  run,
  size = 'sm',
}: {
  run: Pick<AgentRun, 'intent' | 'modeId' | 'autoApprove' | 'entry'>;
  size?: 'sm' | 'md';
}) {
  const view = intentView(run);
  if (!view) return null;
  return (
    <span
      data-intent-chip
      title={view.title}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 font-medium',
        // A plain `Session` (no ticket verb) is drawn quieter than a
        // Fix/Investigate chip, so it reads as intentionally plain rather
        // than a chip missing its data (feedback round 1, Fix 6).
        view.plain
          ? 'border-dashed border-border text-text-muted'
          : 'border-border bg-bg-inset text-text-secondary',
        size === 'sm' ? 'text-[9px] leading-[14px]' : 'text-[10px] leading-4',
      )}
    >
      {view.verb}
      {view.mode && (
        <span
          className={clsx(
            'font-semibold tracking-wide uppercase',
            view.mode === 'auto' ? 'text-warning' : 'text-text-muted',
          )}
        >
          {view.mode}
        </span>
      )}
    </span>
  );
}

export function AutoMark({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      data-auto-mark
      title={MODE_TITLES.auto}
      className={clsx(
        'inline-flex shrink-0 items-center rounded-full border border-warning/40 bg-warning-bg px-1.5 font-semibold tracking-wide text-warning uppercase',
        size === 'sm'
          ? 'text-[8.5px] leading-[14px]'
          : 'text-[9.5px] leading-4',
      )}
    >
      auto
    </span>
  );
}

/**
 * One row of the session list (W3, docs/design/w3-sessions-rail.md §1.4):
 * status dot, title, provider chip or age; the branch line; and, for a run
 * waiting on the user, a third line with the reason. Selection and
 * keyboard focus are the list's (SessionList.tsx) — a row is an `option`
 * in its listbox.
 */
export function SessionRow({
  run,
  selected,
  focused,
  onOpen,
}: {
  run: AgentRun;
  selected: boolean;
  /** The list's roving keyboard cursor is on this row. */
  focused: boolean;
  onOpen: (runId: string) => void;
}) {
  const ticketLabel = useTicketLabel(run.ticketId);
  const home = useHomeDir();
  const title = runTitle(run, ticketLabel);
  const reason = waitingReason(run);
  const where = runWhere(run, home);
  const dispatched = run.entry === 'dispatched';
  const age = formatRelativeTime(run.updatedAt);

  return (
    <div
      role="option"
      aria-selected={selected}
      id={`session-row-${run.id}`}
      data-run-id={run.id}
      // Focusable by script (the listbox moves its cursor with
      // aria-activedescendant), not in the tab order — one Tab stop for
      // the whole list.
      tabIndex={-1}
      onClick={() => onOpen(run.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(run.id);
        }
      }}
      className={clsx(
        'mx-1 flex cursor-default flex-col gap-[3px] rounded-[var(--radius-sm)] px-3 py-[7px] outline-none',
        selected ? 'bg-surface-2' : 'hover:bg-bg-inset',
        focused && 'ring-1 ring-border-strong ring-inset',
      )}
    >
      <div className="flex items-center gap-1.5">
        <SessionStatusDot status={run.status} ring={selected} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text">
          {title}
        </span>
        {/* The verdict is the answer to "how did this go" — against the
            title, not buried in the second line (Sessions UX walkthrough). */}
        <VerdictChip run={run} />
        {reason ? (
          <ProviderChip providerId={run.providerId} />
        ) : (
          <span className="shrink-0 font-mono text-[10px] text-text-muted">
            {age}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-[13px] text-[10.5px] text-text-muted">
        {/* No "Dispatched" chip: it was true of every row from a ticket
            and sat in the row's best position saying nothing. A run from
            a ticket shows its mode instead; an independent run, its
            provider. */}
        {dispatched ? (
          <IntentChip run={run} />
        ) : (
          <>
            <ProviderChip providerId={run.providerId} size={12} />
            {run.autoApprove && <AutoMark />}
          </>
        )}
        {where?.kind === 'branch' && (
          <>
            <IconGitBranch size={10} className="shrink-0" />
            {/* Tail-truncated: `…PL-10-qtp55qy` is the part worth keeping
                when space is short, not `agent/P…`. */}
            <span
              dir="rtl"
              className="min-w-0 truncate text-left font-mono"
              title={where.branch}
            >
              <bdi>{where.branch}</bdi>
            </span>
          </>
        )}
        {where?.kind === 'folder' && (
          <>
            <IconFolder size={10} className="shrink-0" />
            <span
              dir="rtl"
              className="min-w-0 truncate text-left font-mono"
              title={where.path}
            >
              <bdi>{where.path}</bdi>
            </span>
          </>
        )}
        {!where && (
          <span className="truncate">{providerView(run.providerId).name}</span>
        )}
      </div>
      {reason && (
        <div className="truncate pl-[13px] text-[10.5px] text-warning">
          {reason}
        </div>
      )}
    </div>
  );
}
