import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Loader2,
} from 'lucide-react';
import type { Probe } from '@/types/probe';

const STATE_COPY: Record<Probe<unknown>['state'], string> = {
  unknown: 'Not checked',
  checking: 'Checking…',
  present: 'Detected',
  absent: 'Not found',
  error: 'Error',
};

function probeTitle(probe: Probe<unknown>): string | undefined {
  switch (probe.state) {
    case 'present':
      return `via ${probe.via} at ${probe.observedAt}`;
    case 'absent':
    case 'error':
      return `${probe.reason} (via ${probe.via} at ${probe.observedAt})`;
    default:
      return undefined;
  }
}

/**
 * Renders a `Probe<T>`'s five states sensibly — a spinner while checking, an
 * unalarming default for `unknown`, a clear failure state for `error` —
 * without knowing anything about what was probed. Accepts only a `Probe<T>`,
 * so there is no prop that lets a call site fake a "detected" pill for a
 * state nothing ever actually read; hover a settled badge to see exactly
 * what produced the claim (`via`, and when).
 *
 * Domain-specific wrappers (Claude Code detection, backend reachability,
 * repo-link state, ...) render their own label next to this badge — this
 * component only ever speaks in terms of the probe's state, never the
 * thing being probed.
 *
 * See docs/design/waypoint-revamp-architecture.md §7.2.
 */
export function StatusBadge<T>({ probe }: { probe: Probe<T> }) {
  const label = STATE_COPY[probe.state];
  const title = probeTitle(probe);

  if (probe.state === 'checking') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-text-secondary"
        title={title}
      >
        <Loader2 size={12} className="animate-spin" />
        {label}
      </span>
    );
  }

  if (probe.state === 'present') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success"
        title={title}
      >
        <CheckCircle2 size={12} />
        {label}
      </span>
    );
  }

  if (probe.state === 'error') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 text-xs font-medium text-danger"
        title={title}
      >
        <AlertTriangle size={12} />
        {label}
      </span>
    );
  }

  if (probe.state === 'absent') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-text-secondary"
        title={title}
      >
        <CircleSlash size={12} />
        {label}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-text-muted">
      <CircleDashed size={12} />
      {label}
    </span>
  );
}
