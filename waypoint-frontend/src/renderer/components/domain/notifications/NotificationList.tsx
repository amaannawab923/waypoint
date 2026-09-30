import { Fragment, useMemo, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import {
  AtSign,
  Check,
  CornerUpLeft,
  MessageSquare,
  UserPlus,
  Circle,
} from 'lucide-react';
import { IconBell } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { listAgents, listMembers } from '@/data/api';
import type {
  Agent,
  Member,
  NotificationItem,
  NotificationTab,
} from '@/types/entities';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { agentLabel } from '@/lib/agentLabel';
import type { NotificationFeed } from './useNotificationFeed';
import {
  absoluteTime,
  dayLabel,
  notificationSentence,
  rowTime,
} from './notificationText';

// A notification's actor may be a member or an agent — both live in the same
// actorId space (resolveActor in TicketDetailPage does the same).
function actorOf(members: Member[], agents: Agent[], actorId: string) {
  const member = members.find((m) => m.id === actorId);
  if (member)
    return {
      name: member.fullName,
      initialsFrom: member.fullName,
      color: member.avatarColor,
      shape: 'circle' as const,
    };
  const agent = agents.find((a) => a.id === actorId);
  // The "(agent)" suffix is for the sentence, never the avatar's initials.
  if (agent)
    return {
      name: agentLabel(agent.name),
      initialsFrom: agent.name,
      color: agent.avatarColor,
      shape: 'square' as const,
    };
  return undefined;
}

const KIND_GLYPH: Partial<Record<NotificationItem['kind'], typeof AtSign>> = {
  mention: AtSign,
  reply: CornerUpLeft,
  comment: MessageSquare,
  assigned: UserPlus,
};

const EMPTY: Record<NotificationTab, { title: string; description: string }> = {
  all: {
    title: 'You’re all caught up',
    description: 'When someone @mentions you in a comment, it shows up here.',
  },
  mentions: {
    title: 'No mentions',
    description: 'When someone @mentions you in a comment, it shows up here.',
  },
  sessions: {
    title: 'No session updates',
    description: 'Session notifications aren’t sent yet.',
  },
};

/** ↑/↓ between rows; each row's primary button carries data-notification-row. */
function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[data-notification-row]'),
  );
  const i = rows.indexOf(document.activeElement as HTMLElement);
  if (i === -1) return;
  e.preventDefault();
  rows[
    e.key === 'ArrowDown'
      ? Math.min(rows.length - 1, i + 1)
      : Math.max(0, i - 1)
  ]?.focus();
}

export function NotificationList({
  feed,
  tab,
  panelId,
  labelledBy,
  onOpen,
  unreadOnly = false,
  density = 'pane',
}: {
  feed: NotificationFeed;
  tab: NotificationTab;
  panelId: string;
  labelledBy: string;
  onOpen: (n: NotificationItem) => void;
  unreadOnly?: boolean;
  density?: 'pane' | 'page';
}) {
  const { data: people } = useAsync(
    () =>
      Promise.all([listMembers(), listAgents()]).then(([members, agents]) => ({
        members,
        agents,
      })),
    [],
  );
  const { items } = feed;

  const groups = useMemo(() => {
    const out: { label: string; rows: NotificationItem[] }[] = [];
    for (const n of items ?? []) {
      const label = dayLabel(n.updatedAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(n);
      else out.push({ label, rows: [n] });
    }
    return out;
  }, [items]);

  let body;
  if (items === null && !feed.firstError) {
    body = <SkeletonListRows />;
  } else if (items === null) {
    body = (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 px-4 py-6 text-sm text-text-secondary"
      >
        Couldn’t load notifications.
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void feed.retryFirst()}
        >
          Try again
        </Button>
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="px-4 py-10">
        <EmptyState
          icon={
            tab === 'mentions' ? <AtSign size={28} /> : <IconBell size={28} />
          }
          title={unreadOnly ? 'No unread notifications' : EMPTY[tab].title}
          description={unreadOnly ? '' : EMPTY[tab].description}
        />
      </div>
    );
  } else {
    body = (
      <div onKeyDown={onListKeyDown}>
        {groups.map((g) => (
          <Fragment key={g.label}>
            <h3 className="sticky top-0 z-10 border-b border-border bg-surface/95 px-4 py-1.5 text-xs font-medium tracking-wide text-text-muted uppercase backdrop-blur">
              {g.label}
            </h3>
            <ul className="divide-y divide-border">
              {g.rows.map((n) => {
                const who = people
                  ? actorOf(people.members, people.agents, n.actorId)
                  : undefined;
                const name = who?.name ?? 'Someone';
                const sentence = notificationSentence(n);
                const Glyph = KIND_GLYPH[n.kind];
                const when = absoluteTime(n.updatedAt);
                return (
                  <li
                    key={n.id}
                    className={clsx(
                      'group relative flex items-start transition-colors hover:bg-surface-2 focus-within:bg-surface-2',
                      !n.read && 'bg-accent-soft-bg/40',
                    )}
                  >
                    <button
                      type="button"
                      data-notification-row
                      onClick={() => onOpen(n)}
                      aria-label={`${name} ${sentence}${n.read ? '' : ', unread'}, ${when}`}
                      className={clsx(
                        'flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
                        density === 'page' ? 'px-4 py-3' : 'px-4 py-2.5',
                      )}
                    >
                      <span className="relative shrink-0">
                        <Avatar
                          name={who?.initialsFrom ?? '?'}
                          color={who?.color}
                          shape={who?.shape}
                          size={28}
                        />
                        {Glyph && (
                          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-surface bg-surface-3 text-text-secondary">
                            <Glyph
                              size={9}
                              strokeWidth={2.5}
                              aria-hidden="true"
                            />
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={clsx(
                            'line-clamp-2',
                            n.read ? 'text-text-secondary' : 'text-text',
                          )}
                        >
                          <span
                            className={clsx(
                              'text-text',
                              n.read ? 'font-medium' : 'font-semibold',
                            )}
                          >
                            {name}
                          </span>{' '}
                          {sentence}
                        </span>
                        <Tooltip label={when}>
                          <span className="mt-0.5 block text-xs text-text-muted">
                            {rowTime(n.updatedAt)}
                          </span>
                        </Tooltip>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1 py-2.5 pr-3">
                      <button
                        type="button"
                        onClick={() => void feed.setRead(n, !n.read)}
                        aria-label={
                          n.read
                            ? `Mark as unread: ${name} ${sentence}`
                            : `Mark as read: ${name} ${sentence}`
                        }
                        title={n.read ? 'Mark as unread' : 'Mark as read'}
                        className="flex size-6 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-surface-3 hover:text-text focus-visible:opacity-100"
                      >
                        {n.read ? <Circle size={12} /> : <Check size={13} />}
                      </button>
                      <span
                        aria-hidden="true"
                        className={clsx(
                          'size-2 rounded-full',
                          n.read ? 'bg-transparent' : 'bg-accent',
                        )}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Fragment>
        ))}
        {feed.moreError && (
          <p role="alert" className="px-4 pt-3 text-sm text-text-secondary">
            Couldn’t load more notifications.{' '}
            <button
              type="button"
              className="cursor-pointer underline"
              onClick={() => void feed.loadMore()}
            >
              Try again
            </button>
          </p>
        )}
        {feed.nextCursor ? (
          <div className="flex justify-center px-4 py-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void feed.loadMore()}
              disabled={feed.loadingMore}
            >
              {feed.loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : (
          <p className="px-4 py-3 text-center text-xs text-text-muted">
            That’s everything.
          </p>
        )}
      </div>
    );
  }

  return (
    <div id={panelId} role="tabpanel" aria-labelledby={labelledBy}>
      {body}
      <p aria-live="polite" className="sr-only">
        {feed.announcement}
      </p>
      {feed.markAllError && (
        <p role="alert" className="px-4 py-2 text-sm text-danger">
          Couldn’t mark them as read. Try again.
        </p>
      )}
    </div>
  );
}
