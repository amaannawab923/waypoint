import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
} from '@/data/api';
import type { NotificationItem, NotificationTab } from '@/types/entities';
import {
  announceNotificationsChanged,
  NOTIFICATIONS_CHANGED_EVENT,
} from '@/lib/notificationEvents';

const PAGE_SIZE = 30;
/** Same cadence as the topbar bell, so the list and the bell never disagree for long. */
export const NOTIFICATION_POLL_MS = 60_000;

/**
 * One notification list (the pane and the page both use it): first page,
 * Load more, and background refreshes that MERGE into what's loaded instead
 * of collapsing it back to one page.
 */
export function useNotificationFeed(tab: NotificationTab, unreadOnly = false) {
  // null = the first page hasn't arrived. A failed first load and a failed
  // later request are separate states, so a failed refresh never replaces
  // rows already on screen, and each retry repeats what actually failed.
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [firstError, setFirstError] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markAllError, setMarkAllError] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  // Drops responses for a tab/filter the user has already left.
  const generation = useRef(0);

  const loadFirst = useCallback(async () => {
    const gen = ++generation.current;
    setItems(null);
    setFirstError(false);
    setMoreError(false);
    try {
      const page = await listNotifications({
        tab,
        unreadOnly,
        limit: PAGE_SIZE,
      });
      if (gen !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
    } catch {
      if (gen === generation.current) setFirstError(true);
    }
  }, [tab, unreadOnly]);

  // Background refresh: re-read the first page and fold it into what's
  // loaded — new rows on top, changed rows updated in place, the tail the
  // user paged down to (and their scroll position) kept.
  const refresh = useCallback(async () => {
    const gen = generation.current;
    try {
      const page = await listNotifications({
        tab,
        unreadOnly,
        limit: PAGE_SIZE,
      });
      if (gen !== generation.current) return;
      setUnreadCount(page.unreadCount);
      setItems((prev) => {
        if (!prev) return page.items;
        const fresh = new Map(page.items.map((n) => [n.id, n]));
        const kept = prev.filter((n) => !fresh.has(n.id));
        return [...page.items, ...kept].sort((a, b) =>
          a.updatedAt === b.updatedAt
            ? a.id < b.id
              ? 1
              : -1
            : a.updatedAt < b.updatedAt
              ? 1
              : -1,
        );
      });
      setNextCursor((prev) => prev ?? page.nextCursor);
    } catch {
      // A failed background refresh changes nothing: the rows on screen are
      // still what the server last said, and the next trigger retries.
    }
  }, [tab, unreadOnly]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  useEffect(() => {
    const onChange = () => void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, NOTIFICATION_POLL_MS);
    window.addEventListener('focus', onChange);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChange);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('focus', onChange);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChange);
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await listNotifications({
        tab,
        unreadOnly,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      if (gen !== generation.current) return;
      setItems((prev) => {
        const seen = new Set((prev ?? []).map((n) => n.id));
        return [...(prev ?? []), ...page.items.filter((n) => !seen.has(n.id))];
      });
      setNextCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
    } catch {
      if (gen === generation.current) setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, tab, unreadOnly]);

  const setRead = useCallback(async (n: NotificationItem, read: boolean) => {
    if (n.read === read) return;
    const now = new Date().toISOString();
    const patch = (list: NotificationItem[] | null) =>
      list?.map((x) =>
        x.id === n.id ? { ...x, read, readAt: read ? now : null } : x,
      ) ?? null;
    setItems(patch);
    setUnreadCount((c) => Math.max(0, c + (read ? -1 : 1)));
    try {
      await (read ? markNotificationRead(n.id) : markNotificationUnread(n.id));
      announceNotificationsChanged();
    } catch {
      // Put the row back the way the server still has it.
      setItems((list) => list?.map((x) => (x.id === n.id ? n : x)) ?? null);
      setUnreadCount((c) => Math.max(0, c + (read ? 1 : -1)));
    }
  }, []);

  const markAllRead = useCallback(async () => {
    const newest = items?.[0];
    if (!newest) return;
    setMarkAllError(false);
    try {
      // Bounded by the newest row on screen: one that lands meanwhile stays unread.
      const updated = await markAllNotificationsRead(newest.cursor, tab);
      setAnnouncement(
        updated === 1
          ? 'Marked 1 notification as read'
          : `Marked ${updated} notifications as read`,
      );
      announceNotificationsChanged();
    } catch {
      setMarkAllError(true);
    }
  }, [items, tab]);

  return {
    items,
    nextCursor,
    unreadCount,
    firstError,
    moreError,
    markAllError,
    loadingMore,
    announcement,
    retryFirst: loadFirst,
    loadMore,
    setRead,
    markAllRead,
  };
}

export type NotificationFeed = ReturnType<typeof useNotificationFeed>;
