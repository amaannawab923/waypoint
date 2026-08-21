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

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  const color = PRIORITY_COLOR[priority];
  const props = { size, color, strokeWidth: 2.2 };
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
