import type { NotificationItem } from '@/types/entities';

/**
 * The part of a notification's sentence after the actor's name. Rows carry a
 * structured payload and the sentence is rendered here, so a renamed ticket
 * reads right; rows written before that carry a frozen `message`, used as-is.
 */
export function notificationSentence(n: NotificationItem): string {
  const { ticketKey, ticketTitle } = n.payload ?? {};
  const target = ticketKey
    ? `${ticketKey} ${ticketTitle ?? ''}`.trim()
    : ticketTitle;
  if (target) {
    switch (n.kind) {
      case 'mention':
        return `mentioned you on ${target}`;
      case 'reply':
        return `replied to your comment on ${target}`;
      case 'assigned':
        return `assigned you ${target}`;
      case 'comment':
        return `commented on ${target}`;
      default:
        break;
    }
  }
  return n.message ?? 'sent you a notification';
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", a weekday within the last week, else "Sep 12". */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Relative inside today ("just now", "12m", "3h"), clock time before that. */
export function rowTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (startOfDay(d) < startOfDay(now)) {
    return d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  const mins = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
