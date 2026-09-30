import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AtSign } from 'lucide-react';
import { IconBell } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import {
  listNotifications,
  listMembers,
  listAgents,
  markAllNotificationsRead,
  markNotificationRead,
  getTicket,
} from '@/data/api';
import type { Agent, Member, NotificationItem, NotificationTab } from '@/types/entities';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { agentLabel } from '@/lib/agentLabel';
import { EmptyState } from '@/components/ui/EmptyState';
import { NotWired } from '@/components/ui/NotWired';
import { announceNotificationsChanged, NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notificationEvents';
import { SkeletonListRows } from '@/components/ui/Skeleton';

type TabKey = Extract<NotificationTab, 'all' | 'mentions'>;
const PAGE_SIZE = 30;

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}w ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.floor(diffDay / 365)}y ago`;
}

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The part of the sentence after the actor's name. Rows carry a structured
 * payload and the sentence is rendered here, so a renamed ticket reads right;
 * rows written before that carry a frozen `message` instead, used as-is.
 */
export function notificationSentence(n: NotificationItem): string {
  const { ticketKey, ticketTitle } = n.payload ?? {};
  const target = ticketKey ? `${ticketKey} ${ticketTitle ?? ''}`.trim() : ticketTitle;
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

// A notification's actor may be a human member or an agent — both live in
// the same actorId space (see resolveActor in TicketDetailPage for the same
// pattern applied to activity/comment authorship).
function actorOf(
  members: Member[],
  agents: Agent[],
  actorId: string,
): { name: string; color?: string; shape: 'circle' | 'square' } | undefined {
  const member = members.find((m) => m.id === actorId);
  if (member) return { name: member.fullName, color: member.avatarColor, shape: 'circle' };
  const agent = agents.find((a) => a.id === actorId);
  if (agent) return { name: agent.name, color: agent.avatarColor, shape: 'square' };
  return undefined;
}

export default function Notifications() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('all');
  const { data: people } = useAsync(
    () => Promise.all([listMembers(), listAgents()]).then(([members, agents]) => ({ members, agents })),
    [],
  );

  // null = the first page hasn't arrived yet. Kept separate from `error`
  // so a refresh that fails never turns loaded rows into an empty state.
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  // Drops a response for a tab the user has already left.
  const request = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const id = ++request.current;
    setError(false);
    try {
      const page = await listNotifications({ tab, limit: PAGE_SIZE });
      if (id !== request.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
    } catch {
      if (id === request.current) setError(true);
    }
  }, [tab]);

  useEffect(() => {
    setItems(null);
    void loadFirstPage();
  }, [loadFirstPage]);

  // Same triggers as the topbar bell, so the list and its unread pill never
  // disagree with the bell's count.
  useEffect(() => {
    const refresh = () => void loadFirstPage();
    window.addEventListener('focus', refresh);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    };
  }, [loadFirstPage]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const id = request.current;
    setLoadingMore(true);
    try {
      const page = await listNotifications({ tab, limit: PAGE_SIZE, cursor: nextCursor });
      if (id !== request.current) return;
      setItems((prev) => [...(prev ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
    } catch {
      if (id === request.current) setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleMarkAllRead() {
    const newest = items?.[0];
    if (!newest) return;
    setMarkingAll(true);
    try {
      // Bounded by the newest row on screen: one that lands meanwhile stays unread.
      await markAllNotificationsRead(newest.cursor, tab);
      announceNotificationsChanged();
    } finally {
      setMarkingAll(false);
    }
  }

  async function handleOpen(n: NotificationItem) {
    if (!n.read) {
      await markNotificationRead(n.id);
      announceNotificationsChanged();
    }
    if (n.ticketId) {
      const item = await getTicket(n.ticketId);
      if (item) {
        const anchor = n.commentId ? `#comment-${n.commentId}` : '';
        navigate(`/projects/${item.projectId}/tickets/${item.identifier}${anchor}`);
      }
    } else if (n.runId) {
      navigate(`/sessions/${n.runId}`);
    }
  }

  const hasUnreadHere = (items ?? []).some((n) => !n.read);

  return (
    <div className="mx-auto max-w-3xl p-6 md:p-8">
      <div className="flex items-center gap-2">
        <h1 className="font-display text-2xl font-medium text-text">Notifications</h1>
        {unreadCount > 0 && (
          <span className="rounded-full bg-accent-soft-bg px-2 py-0.5 text-xs font-medium text-accent-soft-text">
            {unreadCount} unread
          </span>
        )}
        {hasUnreadHere && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => void handleMarkAllRead()}
            disabled={markingAll}
          >
            {markingAll ? 'Marking…' : 'Mark all as read'}
          </Button>
        )}
      </div>
      <p className="mt-1 text-sm text-text-secondary">
        Things that already happened. Read-only — you can ignore this whole page and nothing breaks.
        Requests are work from outside asking to come in; Review is where an agent is blocked on you and
        nothing happens until you act. Only Review has a cost for inaction.
      </p>
      <div className="mt-3">
        <NotWired capability="notifications.production" />
      </div>

      <div className="mt-5 flex gap-1 border-b border-border" role="tablist" aria-label="Notification filters">
        {(
          [
            { key: 'all', label: 'All' },
            { key: 'mentions', label: 'Mentions' },
          ] as { key: TabKey; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={
              'cursor-pointer border-b-2 px-3 py-2 text-sm font-medium transition-colors ' +
              (tab === t.key
                ? 'border-accent text-text'
                : 'border-transparent text-text-secondary hover:text-text')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {items === null && !error ? (
          <div className="rounded-[var(--radius-lg)] border border-border bg-surface">
            <SkeletonListRows />
          </div>
        ) : items === null ? (
          <div role="alert" className="flex items-center gap-3 text-sm text-text-secondary">
            Couldn’t load notifications.
            <Button variant="secondary" size="sm" onClick={() => void loadFirstPage()}>
              Try again
            </Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={tab === 'mentions' ? <AtSign size={28} /> : <IconBell size={28} />}
            title={tab === 'mentions' ? 'No mentions' : 'You’re all caught up'}
            description={
              tab === 'mentions'
                ? 'When someone @mentions you, it will show up here.'
                : 'When someone @mentions you in a comment, it will show up here.'
            }
          />
        ) : (
          <>
            <div className="divide-y divide-border rounded-[var(--radius-lg)] border border-border bg-surface">
              {items.map((n) => {
                const who = people ? actorOf(people.members, people.agents, n.actorId) : undefined;
                const name = who ? (who.shape === 'square' ? agentLabel(who.name) : who.name) : 'Someone';
                const sentence = notificationSentence(n);
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => void handleOpen(n)}
                    aria-label={`${name} ${sentence}${n.read ? '' : ', unread'}, ${absoluteTime(n.updatedAt)}`}
                    className={
                      'flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-surface-2 ' +
                      (n.read ? '' : 'bg-accent-soft-bg/40')
                    }
                  >
                    <Avatar name={who?.name ?? '?'} color={who?.color} shape={who?.shape} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className={n.read ? 'text-text' : 'font-medium text-text'}>
                        <span className="font-medium">{name}</span>{' '}
                        <span className="text-text-secondary">{sentence}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-text-muted" title={absoluteTime(n.updatedAt)}>
                        {relativeTime(n.updatedAt)}
                      </p>
                    </div>
                    {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
            {error && (
              <p role="alert" className="mt-3 text-sm text-text-secondary">
                Couldn’t load more notifications.{' '}
                <button type="button" className="underline" onClick={() => void loadMore()}>
                  Try again
                </button>
              </p>
            )}
            {nextCursor ? (
              <div className="mt-3 flex justify-center">
                <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-center text-xs text-text-muted">That’s everything.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
