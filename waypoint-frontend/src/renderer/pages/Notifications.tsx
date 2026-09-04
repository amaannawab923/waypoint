import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AtSign } from 'lucide-react';
import { IconBell } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { listNotifications, listMembers, listAgents, markNotificationRead, getTicket } from '@/data/api';
import type { Agent, Member, NotificationItem } from '@/types/entities';
import { Avatar } from '@/components/ui/Avatar';
import { agentLabel } from '@/lib/agentLabel';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonListRows } from '@/components/ui/Skeleton';

type TabKey = 'all' | 'mentions';

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

async function loadNotifications() {
  const [notifications, members, agents] = await Promise.all([listNotifications(), listMembers(), listAgents()]);
  return { notifications, members, agents };
}

export default function Notifications() {
  const { data, loading, reload } = useAsync(() => loadNotifications(), []);
  const [tab, setTab] = useState<TabKey>('all');
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    if (!data) return [] as NotificationItem[];
    return tab === 'mentions' ? data.notifications.filter((n) => n.kind === 'mention') : data.notifications;
  }, [data, tab]);

  // A notification's actor may be a human member or an agent — both live in
  // the same actorId space (see resolveActor in TicketDetailPage for the
  // same pattern applied to activity/comment authorship).
  function actor(
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

  async function handleOpen(n: NotificationItem) {
    if (!n.read) {
      await markNotificationRead(n.id);
      reload();
    }
    if (n.ticketId) {
      const item = await getTicket(n.ticketId);
      if (item) {
        navigate(`/projects/${item.projectId}/tickets/${item.identifier}`);
      }
    }
  }

  const unreadCount = data?.notifications.filter((n) => !n.read).length ?? 0;

  return (
    <div className="mx-auto max-w-3xl p-6 md:p-8">
      <div className="flex items-center gap-2">
        <h1 className="font-display text-2xl font-medium text-text">Notifications</h1>
        {unreadCount > 0 && (
          <span className="rounded-full bg-accent-soft-bg px-2 py-0.5 text-xs font-medium text-accent-soft-text">
            {unreadCount} unread
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-text-secondary">
        Things that already happened. Read-only — you can ignore this whole page and nothing breaks.
        Requests are work from outside asking to come in; Review is where an agent is blocked on you and
        nothing happens until you act. Only Review has a cost for inaction.
      </p>

      <div className="mt-5 flex gap-1 border-b border-border">
        {(
          [
            { key: 'all', label: 'All' },
            { key: 'mentions', label: 'Mentions' },
          ] as { key: TabKey; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            type="button"
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
        {loading && !data ? (
          <div className="rounded-[var(--radius-lg)] border border-border bg-surface">
            <SkeletonListRows />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={tab === 'mentions' ? <AtSign size={28} /> : <IconBell size={28} />}
            title={tab === 'mentions' ? 'No mentions' : 'You’re all caught up'}
            description={
              tab === 'mentions'
                ? 'When someone @mentions you, it will show up here.'
                : 'New notifications will show up here as things happen.'
            }
          />
        ) : (
          <div className="divide-y divide-border rounded-[var(--radius-lg)] border border-border bg-surface">
            {filtered.map((n) => {
              const who = data ? actor(data.members, data.agents, n.actorId) : undefined;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleOpen(n)}
                  className={
                    'flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-surface-2 ' +
                    (n.read ? '' : 'bg-accent-soft-bg/40')
                  }
                >
                  <Avatar name={who?.name ?? '?'} color={who?.color} shape={who?.shape} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className={n.read ? 'text-text' : 'font-medium text-text'}>
                      <span className="font-medium">
                        {who ? (who.shape === 'square' ? agentLabel(who.name) : who.name) : 'Someone'}
                      </span>{' '}
                      <span className="text-text-secondary">{n.message}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">{relativeTime(n.createdAt)}</p>
                  </div>
                  {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
