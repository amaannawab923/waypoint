import { IconDashed, IconCircle, IconCircleDot, IconCheck, IconXCircle } from '@/components/icons';
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

// Matches docs/design/waypoint-revamp-mockup.html's own state-group ->
// icon mapping one for one (dashed/circle/circledot/check/xcircle from its
// ICONS set) — the mockup's "check" is a plain outline circle with a
// checkmark inside, not a solid filled circle, so `completed` no longer
// fills the glyph the way the previous lucide CircleCheck did.
export function StateIcon({ state, size = 14 }: { state: Pick<TicketState, 'group' | 'color'>; size?: number }) {
  const props = { size, strokeWidth: 2.2, style: { color: state.color } };
  switch (state.group) {
    case 'backlog':
      return <IconDashed {...props} />;
    case 'unstarted':
      return <IconCircle {...props} />;
    case 'started':
      return <IconCircleDot {...props} />;
    case 'completed':
      return <IconCheck {...props} />;
    case 'cancelled':
      return <IconXCircle {...props} />;
    default:
      return <IconCircle {...props} />;
  }
}
