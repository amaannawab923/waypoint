import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCheck, Settings2 } from 'lucide-react';
import type { NotificationItem, NotificationTab } from '@/types/entities';
import { Button } from '@/components/ui/Button';
import { NotWired } from '@/components/ui/NotWired';
import { NotificationList } from '@/components/domain/notifications/NotificationList';
import { NotificationTabs, UnreadSwitch } from '@/components/domain/notifications/NotificationTabs';
import { PAGE_PAGE_SIZE, useNotificationFeed } from '@/components/domain/notifications/useNotificationFeed';
import { openNotificationTarget } from '@/components/domain/notifications/openNotification';
import { readRememberedTab, rememberTab } from '@/components/domain/notifications/rememberedTab';

/**
 * The full-page view of the bell's side pane ("Open full page"): the same
 * list, with room for long history.
 */
export default function Notifications() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<NotificationTab>(() => readRememberedTab());
  const [unreadOnly, setUnreadOnly] = useState(false);
  const feed = useNotificationFeed(tab, { unreadOnly, pageSize: PAGE_PAGE_SIZE });

  function changeTab(next: NotificationTab) {
    setTab(next);
    rememberTab(next);
  }

  async function open(n: NotificationItem) {
    void feed.setRead(n, true);
    await openNotificationTarget(n, navigate);
  }

  const hasUnread = (feed.items ?? []).some((n) => !n.read);

  return (
    <div className="mx-auto max-w-[760px] px-6 py-8 md:px-8 md:py-10">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2.5 font-display text-[26px] font-medium tracking-tight text-text">
            Notifications
            {feed.unreadCount > 0 && (
              <span className="rounded-full bg-info-bg px-2 py-0.5 font-body text-[12px] font-semibold tracking-normal text-info tabular-nums">
                {feed.unreadCount} new
              </span>
            )}
          </h1>
          <p className="mt-1 text-[13.5px] text-text-secondary">
            What needs you, newest first. Open one to jump straight to it; agent proposals are decided in{' '}
            <Link to="/review" className="font-medium text-text underline decoration-border-strong underline-offset-2 hover:decoration-text">
              Review
            </Link>
            .
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={!hasUnread}
            className={hasUnread ? undefined : 'cursor-default opacity-40'}
            onClick={() => {
              if (hasUnread) void feed.markAllRead();
            }}
          >
            <CheckCheck size={15} className="mr-1.5" />
            Mark all as read
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate('/profile/notifications')}>
            <Settings2 size={14} className="mr-1.5" />
            Settings
          </Button>
        </div>
      </header>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <NotificationTabs idPrefix="notifications-page" value={tab} onChange={changeTab} />
        <UnreadSwitch id="notifications-page-unread" checked={unreadOnly} onChange={setUnreadOnly} />
      </div>

      {/* overflow-clip, not overflow-hidden: -hidden makes this a scroll
          container, which the sticky day headers would stick to (and it
          never scrolls). */}
      <div className="mt-4 overflow-clip rounded-[var(--radius-lg)] border border-border bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.03)]">
        <NotificationList
          feed={feed}
          tab={tab}
          panelId="notifications-page-panel"
          labelledBy={`notifications-page-tab-${tab}`}
          onOpen={(n) => void open(n)}
          unreadOnly={unreadOnly}
        />
      </div>
      <div className="mt-4">
        <NotWired capability="notifications.production" />
      </div>
    </div>
  );
}
