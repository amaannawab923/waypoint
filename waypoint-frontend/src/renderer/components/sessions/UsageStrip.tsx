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
}: {
  turnCount: number;
  usage: SessionUsage | null;
  live: FollowerStatus['kind'];
  generating: boolean;
}) {
  return (
    <div
      data-usage-strip
      className="flex shrink-0 items-center gap-3.5 border-t border-border px-4 py-1 font-mono text-[10px] text-text-muted"
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
      {generating && <span className="text-info">working…</span>}
      <span className={live === 'live' ? 'text-success' : ''}>
        {LIVE_WORD[live]}
      </span>
    </div>
  );
}
