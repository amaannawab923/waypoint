import { clsx } from 'clsx';
import { Badge, Dot, type BadgeTone } from '@/components/ui/Badge';
import type { AgentRunStatus } from '@/types/entities';

export const AGENT_STATUS_CONFIG: Record<AgentRunStatus, { label: string; tone: BadgeTone; dot: string }> = {
  queued: { label: 'Queued', tone: 'neutral', dot: 'var(--text-muted)' },
  running: { label: 'Running', tone: 'info', dot: 'var(--info)' },
  'needs-review': { label: 'Needs review', tone: 'warning', dot: 'var(--warning)' },
  blocked: { label: 'Blocked', tone: 'danger', dot: 'var(--danger)' },
  done: { label: 'Done', tone: 'success', dot: 'var(--success)' },
  failed: { label: 'Failed', tone: 'danger', dot: 'var(--danger)' },
};

export function AgentStatusBadge({ status, className }: { status: AgentRunStatus; className?: string }) {
  const cfg = AGENT_STATUS_CONFIG[status];
  return (
    <Badge tone={cfg.tone} className={className}>
      <Dot color={cfg.dot} className={clsx(status === 'running' && 'animate-pulse')} />
      {cfg.label}
    </Badge>
  );
}
