import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NotificationItem, NotificationTab } from '@/types/entities';
import { Button } from '@/components/ui/Button';
import { NotWired } from '@/components/ui/NotWired';
import { NotificationList } from '@/components/domain/notifications/NotificationList';
import { NotificationTabs } from '@/components/domain/notifications/NotificationTabs';
import { useNotificationFeed } from '@/components/domain/notifications/useNotificationFeed';
import { openNotificationTarget } from '@/components/domain/notifications/openNotification';
import {
  readRememberedTab,
  rememberTab,
} from '@/components/domain/notifications/rememberedTab';

/**
 * The full-page view of the bell's side pane ("Open full page"): the same
 * list, with room for long history and an Unread-only filter.
 */
export default function Notifications() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<NotificationTab>(() => readRememberedTab());
  const [unreadOnly, setUnreadOnly] = useState(false);
  const feed = useNotificationFeed(tab, { unreadOnly });

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
    <div className="mx-auto max-w-3xl p-6 md:p-8">
      <div className="flex items-center gap-2">
        <h1 className="font-display text-2xl font-medium text-text">
          Notifications
        </h1>
        {feed.unreadCount > 0 && (
          <span className="rounded-full bg-accent-soft-bg px-2 py-0.5 text-xs font-medium text-accent-soft-text">
            {feed.unreadCount} unread
          </span>
        )}
        {hasUnread && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => void feed.markAllRead()}
          >
            Mark all as read
          </Button>
        )}
      </div>
      <p className="mt-1 text-sm text-text-secondary">
        Things addressed to you. Open one to jump straight to it; decisions on
        agent proposals happen in Review.
      </p>
      <div className="mt-3">
        <NotWired capability="notifications.production" />
      </div>

      <div className="mt-5 flex items-end gap-3 border-b border-border">
        <NotificationTabs
          idPrefix="notifications-page"
          value={tab}
          onChange={changeTab}
          className="border-b-0"
        />
        <label className="mb-2 ml-auto flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
          <input
            id="notifications-unread-only"
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Unread only
        </label>
      </div>

      <div className="mt-4 overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface">
        <NotificationList
          feed={feed}
          tab={tab}
          panelId="notifications-page-panel"
          labelledBy={`notifications-page-tab-${tab}`}
          onOpen={(n) => void open(n)}
          unreadOnly={unreadOnly}
          density="page"
        />
      </div>
    </div>
  );
}
