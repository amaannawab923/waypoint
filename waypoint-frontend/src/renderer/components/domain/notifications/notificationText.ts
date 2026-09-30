import type { NotificationItem } from '@/types/entities';

export interface DescribedNotification {
  /** What the actor did, after their name ("mentioned you"). */
  verb: string;
  /** Other people folded into a grouped row ("and 2 others"). */
  others: number;
  ticketKey?: string;
  ticketTitle?: string;
  snippet?: string;
  /** Short type label for the row's meta line. */
  kindLabel: string;
  /** Rows written before payloads existed carry a finished sentence. */
  legacy?: string;
}

/**
 * A notification, taken apart for display. Rows carry a structured payload
 * and the sentence is built here (so a renamed ticket reads right); rows
 * written before that carry a frozen `message`, used as-is.
 */
export function describeNotification(n: NotificationItem): DescribedNotification {
  const p = n.payload ?? {};
  const distinctActors = new Set(p.actorIds ?? [n.actorId]).size;
  const count = p.count ?? 1;
  const base = { ticketKey: p.ticketKey, ticketTitle: p.ticketTitle, snippet: p.snippet || undefined };
  const hasTarget = Boolean(p.ticketKey || p.ticketTitle);
  switch (n.kind) {
    case 'mention':
      if (hasTarget) return { ...base, verb: 'mentioned you', others: 0, kindLabel: 'Mention' };
      break;
    case 'reply':
      if (hasTarget) return { ...base, verb: 'replied to your comment', others: 0, kindLabel: 'Reply' };
      break;
    case 'comment':
      if (hasTarget)
        return {
          ...base,
          verb: count > 1 ? `left ${count} comments` : 'commented',
          others: Math.max(0, distinctActors - 1),
          kindLabel: 'Comment',
        };
      break;
    case 'assigned':
      if (hasTarget)
        return {
          ...base,
          verb: p.created ? 'created a ticket for you' : 'assigned you',
          others: 0,
          kindLabel: 'Assigned',
        };
      break;
    default:
      break;
  }
  return {
    verb: '',
    others: 0,
    kindLabel: KIND_LABELS[n.kind] ?? 'Notification',
    legacy: n.message ?? 'sent you a notification',
  };
}

const KIND_LABELS: Partial<Record<NotificationItem['kind'], string>> = {
  mention: 'Mention',
  reply: 'Reply',
  comment: 'Comment',
  assigned: 'Assigned',
  state_change: 'Status',
  agent_blocked: 'Session',
  agent_needs_review: 'Session',
};

/** The whole sentence after the actor's name — for accessible names and tests. */
export function notificationSentence(n: NotificationItem): string {
  const d = describeNotification(n);
  if (d.legacy) return d.legacy;
  const others = d.others > 0 ? `and ${d.others} other${d.others === 1 ? '' : 's'} ` : '';
  const target = [d.ticketKey, d.ticketTitle].filter(Boolean).join(' ');
  return `${others}${d.verb}${target ? ` on ${target}` : ''}`;
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
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
