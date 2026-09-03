import { Circle, CircleDot, CircleCheck, CircleX, CircleDashed } from 'lucide-react';
import type { StateGroup, TicketState } from '@/types/entities';

export const STATE_GROUP_LABEL: Record<StateGroup, string> = {
  backlog: 'Backlog',
  unstarted: 'Unstarted',
  started: 'Started',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** Fixed ordering for grouped board/list columns — mirrors the backend's state-group taxonomy. */
export const STATE_GROUP_ORDER: StateGroup[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];

export function StateIcon({ state, size = 14 }: { state: Pick<TicketState, 'group' | 'color'>; size?: number }) {
  const props = { size, color: state.color, strokeWidth: 2.2 };
  switch (state.group) {
    case 'backlog':
      return <CircleDashed {...props} />;
    case 'unstarted':
      return <Circle {...props} />;
    case 'started':
      return <CircleDot {...props} />;
    case 'completed':
      return <CircleCheck {...props} fill={state.color} color="var(--surface)" />;
    case 'cancelled':
      return <CircleX {...props} />;
    default:
      return <Circle {...props} />;
  }
}
