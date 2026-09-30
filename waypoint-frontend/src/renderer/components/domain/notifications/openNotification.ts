import type { NavigateFunction } from 'react-router-dom';
import { getTicket } from '@/data/api';
import type { NotificationItem } from '@/types/entities';

const SESSION_KINDS: NotificationItem['kind'][] = [
  'agent_blocked',
  'agent_needs_review',
];

/**
 * Where a notification takes you. Session kinds open the session even when
 * the run is on a ticket; everything else opens its ticket, at the exact
 * comment when there is one.
 */
export async function openNotificationTarget(
  n: NotificationItem,
  navigate: NavigateFunction,
): Promise<void> {
  if (n.runId && SESSION_KINDS.includes(n.kind)) {
    navigate(`/sessions/${n.runId}`);
    return;
  }
  if (n.ticketId) {
    const ticket = await getTicket(n.ticketId);
    if (ticket) {
      navigate(
        `/projects/${ticket.projectId}/tickets/${ticket.identifier}${n.commentId ? `#comment-${n.commentId}` : ''}`,
      );
      return;
    }
  }
  if (n.runId) navigate(`/sessions/${n.runId}`);
}
