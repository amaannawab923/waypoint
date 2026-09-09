import { SignalHigh, SignalMedium, SignalLow, AlertTriangle, Minus } from 'lucide-react';
import type { Priority } from '@/types/entities';

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None',
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  urgent: 'var(--danger)',
  high: 'var(--warning)',
  medium: 'var(--info)',
  low: 'var(--text-secondary)',
  none: 'var(--text-muted)',
};

export const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

export function PriorityIcon({
  priority,
  size = 14,
  label,
}: {
  priority: Priority;
  size?: number;
  /**
   * Real accessible name for a call site where this icon is the ONLY
   * signal of priority (no adjacent visible text, e.g. List/Board's bare
   * icon usage) — most call sites already sit next to a visible
   * PRIORITY_LABEL string, so this defaults to undefined (decorative,
   * aria-hidden) rather than every icon needing one.
   */
  label?: string;
}) {
  const color = PRIORITY_COLOR[priority];
  const props = label
    ? { size, color, strokeWidth: 2.2, role: 'img' as const, 'aria-label': label }
    : { size, color, strokeWidth: 2.2, 'aria-hidden': true as const };
  switch (priority) {
    case 'urgent':
      return <AlertTriangle {...props} />;
    case 'high':
      return <SignalHigh {...props} />;
    case 'medium':
      return <SignalMedium {...props} />;
    case 'low':
      return <SignalLow {...props} />;
    default:
      return <Minus {...props} />;
  }
}
