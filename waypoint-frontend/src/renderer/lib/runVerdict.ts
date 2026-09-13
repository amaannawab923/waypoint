import type { BadgeTone } from '@/components/ui/Badge';
import type { RunVerdict } from '@/types/agentRuns';

/**
 * A run's verdict as a person reads it (W5c) — the same words main's
 * report.ts uses on the comment and in the Copilot note, mirrored here
 * because the renderer never imports main at runtime.
 */
export const VERDICT_LABEL: Record<RunVerdict, string> = {
  'root-cause': 'root cause found',
  fixed: 'fixed',
  partial: 'partly fixed',
  'not-a-bug': 'not a bug',
  'wont-fix': "won't fix",
  'needs-info': 'needs a decision',
};

export function verdictLabel(verdict: RunVerdict): string {
  return VERDICT_LABEL[verdict];
}

/** A verdict that closes the ticket rather than moving it forward. */
export function isClosingVerdict(verdict: RunVerdict | null): boolean {
  return verdict === 'not-a-bug' || verdict === 'wont-fix';
}

/** The chip's colour: green for a conclusion that moves the ticket, neutral for one that closes it, amber for one that needs a person. */
export function verdictTone(verdict: RunVerdict): BadgeTone {
  switch (verdict) {
    case 'root-cause':
    case 'fixed':
      return 'success';
    case 'partial':
    case 'needs-info':
      return 'warning';
    default:
      return 'neutral';
  }
}
