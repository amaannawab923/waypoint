import { Fragment, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { AtSign, Check, CornerUpLeft, MessageSquare, UserPlus, Undo2, Bell } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { listAgents, listMembers, listProjects } from '@/data/api';
import type { Agent, Member, NotificationItem, NotificationTab, Project } from '@/types/entities';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { agentLabel } from '@/lib/agentLabel';
import type { NotificationFeed } from './useNotificationFeed';
import { absoluteTime, dayLabel, describeNotification, notificationSentence, rowTime } from './notificationText';

// A notification's actor may be a member or an agent — both live in the same
// actorId space (resolveActor in TicketDetailPage does the same).
function actorOf(members: Member[], agents: Agent[], actorId: string) {
  const member = members.find((m) => m.id === actorId);
  if (member) {
    return { name: member.fullName, initialsFrom: member.fullName, color: member.avatarColor, shape: 'circle' as const };
  }
  const agent = agents.find((a) => a.id === actorId);
  // The "(agent)" suffix is for the sentence, never the avatar's initials.
  if (agent) {
    return { name: agentLabel(agent.name), initialsFrom: agent.name, color: agent.avatarColor, shape: 'square' as const };
  }
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
    description: 'Mentions, replies, assignments and comments on tickets you follow land here.',
  },
  mentions: {
    title: 'No mentions',
    description: 'When someone @mentions you or replies to your comment, it lands here.',
  },
  assigned: {
    title: 'Nothing assigned',
    description: 'When someone assigns you a ticket, it lands here.',
  },
  sessions: {
    title: 'No session updates',
    description: 'Session notifications aren’t sent yet.',
  },
};

/**
 * @Names in a quoted comment read as names, not as punctuation — only where
 * an @ starts a word, so an email address isn't half-highlighted.
 */
function withMentions(text: string): ReactNode[] {
  return text.split(/((?<=^|\s)@[\p{L}\p{N}._-]+)/u).map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className="font-medium text-text">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/** ↑/↓ between rows; each row's primary button carries data-notification-row. */
function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-notification-row]'));
  const i = rows.indexOf(document.activeElement as HTMLElement);
  if (i === -1) return;
  e.preventDefault();
  rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
}

function RowSkeleton() {
  return (
    <div className="flex gap-3 px-3 py-3.5" aria-hidden="true">
      <span className="size-8 shrink-0 animate-pulse rounded-full bg-surface-2" />
      <span className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <span className="h-3 w-3/5 animate-pulse rounded bg-surface-2" />
        <span className="h-3 w-4/5 animate-pulse rounded bg-surface-2" />
        <span className="h-2.5 w-2/5 animate-pulse rounded bg-surface-2" />
      </span>
    </div>
  );
}

function NotificationRow({
  n,
  people,
  project,
  onOpen,
  onToggleRead,
}: {
  n: NotificationItem;
  people: { members: Member[]; agents: Agent[] } | undefined;
  project: Project | undefined;
  onOpen: () => void;
  onToggleRead: () => void;
}) {
  const who = people ? actorOf(people.members, people.agents, n.actorId) : undefined;
  const name = who?.name ?? 'Someone';
  const d = describeNotification(n);
  const Glyph = KIND_GLYPH[n.kind] ?? Bell;
  const when = absoluteTime(n.updatedAt);
  const unread = !n.read;
  const sentence = notificationSentence(n);

  return (
    <li className="group relative">
      <button
        type="button"
        data-notification-row
        onClick={onOpen}
        aria-label={`${name} ${sentence}${unread ? ', unread' : ''}, ${when}`}
        // The label replaces the button's content, so the quote and the
        // project/kind line are read out as its description.
        aria-describedby={[d.snippet ? `${n.id}-quote` : null, `${n.id}-meta`].filter(Boolean).join(' ')}
        className={clsx(
          'relative flex w-full cursor-pointer gap-3 rounded-[12px] px-3 py-3.5 text-left transition-colors outline-none',
          'hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/30',
        )}
      >
        {unread && (
          <span aria-hidden="true" className="absolute top-[26px] left-[3px] size-1.5 rounded-full bg-info" />
        )}
        <span className="mt-0.5 flex size-8 shrink-0">
          <Avatar name={who?.initialsFrom ?? '?'} color={who?.color} shape={who?.shape} size={32} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-3">
            <span className={clsx('min-w-0 flex-1 text-[13.5px] leading-5', d.legacy ? 'line-clamp-2' : 'truncate')}>
              <span className={clsx('text-text', unread ? 'font-semibold' : 'font-medium')}>{name}</span>
              {d.others > 0 && (
                <span className="text-text-secondary">
                  {' '}
                  and {d.others} other{d.others === 1 ? '' : 's'}
                </span>
              )}{' '}
              <span className="text-text-secondary">{d.legacy ?? d.verb}</span>
            </span>
            {/* The exact time is in the row's accessible name and title; the
                read/unread action takes this spot on hover. */}
            <span
              title={when}
              className="shrink-0 text-[11.5px] text-text-muted tabular-nums transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
            >
              {rowTime(n.updatedAt)}
            </span>
          </span>
          {(d.ticketKey || d.ticketTitle) && (
            <span className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5">
              {d.ticketKey && (
                <span className="shrink-0 font-mono text-[11.5px] text-text-muted">{d.ticketKey}</span>
              )}
              <span className={clsx('truncate', unread ? 'text-text' : 'text-text-secondary')}>{d.ticketTitle}</span>
            </span>
          )}
          {d.snippet && (
            <span
              id={`${n.id}-quote`}
              className="mt-1.5 line-clamp-2 border-l-2 border-border-strong pl-2.5 text-[12.5px] leading-[18px] text-text-secondary"
            >
              {withMentions(d.snippet)}
            </span>
          )}
          <span id={`${n.id}-meta`} className="mt-2 flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-text-muted">
            <Glyph size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
            <span className="shrink-0">{d.kindLabel}</span>
            {project && (
              <>
                <span aria-hidden="true">·</span>
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-[3px]"
                  style={{ background: `linear-gradient(135deg, ${project.coverGradient[0]}, ${project.coverGradient[1]})` }}
                />
                <span className="truncate">{project.name}</span>
              </>
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onToggleRead}
        aria-label={unread ? `Mark as read: ${name} ${sentence}` : `Mark as unread: ${name} ${sentence}`}
        title={unread ? 'Mark as read' : 'Mark as unread'}
        className="absolute top-2.5 right-2.5 flex size-7 cursor-pointer items-center justify-center rounded-[8px] border border-border bg-surface text-text-secondary opacity-0 shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-text focus-visible:opacity-100"
      >
        {unread ? <Check size={14} /> : <Undo2 size={13} />}
      </button>
    </li>
  );
}

export function NotificationList({
  feed,
  tab,
  panelId,
  labelledBy,
  onOpen,
  unreadOnly = false,
  footer,
}: {
  feed: NotificationFeed;
  tab: NotificationTab;
  panelId: string;
  labelledBy: string;
  onOpen: (n: NotificationItem) => void;
  unreadOnly?: boolean;
  /** Shown under the list, whatever state it's in (the honesty notice). */
  footer?: ReactNode;
}) {
  const { data: people } = useAsync(
    () => Promise.all([listMembers(), listAgents()]).then(([members, agents]) => ({ members, agents })),
    [],
  );
  const { data: projects } = useAsync(() => listProjects(), []);
  const projectById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);
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
    body = (
      <div className="px-2 pt-2">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    );
  } else if (items === null) {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <p className="text-[13.5px] font-medium text-text">Couldn’t load notifications</p>
        <Button variant="secondary" size="sm" onClick={() => void feed.retryFirst()}>
          Try again
        </Button>
      </div>
    );
  } else if (items.length === 0) {
    const copy = unreadOnly
      ? { title: 'No unread notifications', description: 'Everything here has been read.' }
      : EMPTY[tab];
    body = (
      <div className="flex flex-col items-center px-8 py-16 text-center">
        <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-surface-2 text-text-muted">
          <Bell size={20} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <p className="font-display text-[15px] font-medium text-text">{copy.title}</p>
        <p className="mt-1.5 max-w-[280px] text-[13px] leading-5 text-text-secondary">{copy.description}</p>
      </div>
    );
  } else {
    body = (
      <div onKeyDown={onListKeyDown} className="pb-2">
        {groups.map((g) => (
          <Fragment key={g.label}>
            {/* No per-day count: it would only count the rows loaded so far,
                and read as a total while "Show more" still has more. */}
            <div className="sticky top-0 z-10 bg-surface/90 px-5 pt-4 pb-1.5 backdrop-blur-sm">
              <h3 className="text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">{g.label}</h3>
            </div>
            <ul className="flex flex-col gap-0.5 px-2">
              {g.rows.map((n) => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  people={people}
                  project={n.payload?.projectId ? projectById.get(n.payload.projectId) : undefined}
                  onOpen={() => onOpen(n)}
                  onToggleRead={() => void feed.setRead(n, !n.read)}
                />
              ))}
            </ul>
          </Fragment>
        ))}
        {feed.moreError && (
          <p role="alert" className="px-5 pt-3 text-[13px] text-text-secondary">
            Couldn’t load more notifications.{' '}
            <button type="button" className="cursor-pointer font-medium text-text underline" onClick={() => void feed.loadMore()}>
              Try again
            </button>
          </p>
        )}
        {feed.nextCursor ? (
          <div className="flex flex-col items-center gap-1.5 px-4 pt-3 pb-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void feed.loadMore()}
              disabled={feed.loadingMore}
              className="min-w-[128px] rounded-full"
            >
              {feed.loadingMore ? 'Loading…' : 'Show more'}
            </Button>
            <span className="text-[11px] text-text-muted tabular-nums">Showing {items.length}</span>
          </div>
        ) : (
          <p className="px-4 pt-4 text-center text-[11.5px] text-text-muted">That’s everything.</p>
        )}
      </div>
    );
  }

  return (
    <div id={panelId} role="tabpanel" aria-labelledby={labelledBy}>
      {body}
      {feed.markAllError && (
        <p role="alert" className="px-5 py-2 text-[13px] text-danger">
          Couldn’t mark them as read. Try again.
        </p>
      )}
      {footer}
      <p aria-live="polite" className="sr-only">
        {feed.announcement}
      </p>
    </div>
  );
}
