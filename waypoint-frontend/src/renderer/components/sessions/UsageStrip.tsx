import type { SessionUsage } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import type { FollowerStatus } from '@/data/live/liveFollower';

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const LIVE_WORD: Record<FollowerStatus['kind'], string> = {
  connecting: 'connecting',
  live: 'live',
  stale: 'resyncing',
  closed: 'not live',
};

/** Hover text for the live word (feedback round 1, Fix 6): what each state means for a message sent now. */
const LIVE_TITLE: Record<FollowerStatus['kind'], string> = {
  connecting: 'Connecting to the agent process.',
  live: 'The agent process is still running — message it and it replies immediately.',
  stale: 'The connection dropped; catching up with the agent process.',
  closed:
    "This run's process has stopped. Message it and Waypoint restarts it in the same worktree.",
};

/**
 * The strip under the composer (W3): committed turns as the transcript
 * counts them, context used / size and cost from the daemon's
 * `acp.session.usage` — each only when its source has actually said so. A
 * provider that reports no cost shows no cost; a session with no usage
 * yet shows only the turns.
 */
export function UsageStrip({
  turnCount,
  usage,
  live,
  generating,
  queued = 0,
}: {
  turnCount: number;
  usage: SessionUsage | null;
  live: FollowerStatus['kind'];
  generating: boolean;
  /** Prompts the daemon holds for the next turn (W4). */
  queued?: number;
}) {
  return (
    <div
      data-usage-strip
      className="flex shrink-0 items-center gap-3.5 border-t border-border px-4 py-1 font-mono text-[10.5px] text-text-secondary"
    >
      <span>{turnCount === 1 ? '1 turn' : `${turnCount} turns`}</span>
      {usage && usage.contextSize > 0 && (
        <span title="Context used of the model's window">
          {compact(usage.contextUsed)} / {compact(usage.contextSize)} ctx
        </span>
      )}
      {usage?.cost && (
        <span>
          {usage.cost.currency === 'USD' ? '$' : `${usage.cost.currency} `}
          {usage.cost.amount.toFixed(2)}
        </span>
      )}
      <span className="flex-1" />
      {queued > 0 && (
        <span title="Sent during a turn; delivered when it ends">
          {queued} queued
        </span>
      )}
      {generating && <span className="text-info">working…</span>}
      <span
        title={LIVE_TITLE[live]}
        className={live === 'live' ? 'text-success' : ''}
      >
        {LIVE_WORD[live]}
      </span>
    </div>
  );
}
