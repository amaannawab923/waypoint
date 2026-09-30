import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
} from '@/data/api';
import type { NotificationItem, NotificationPage, NotificationTab } from '@/types/entities';
import { announceNotificationsChanged, NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notificationEvents';

/**
 * How many rows a list starts with and adds per "Show more". The pane is a
 * glance, so it starts small; the full page has room for more.
 */
export const PANE_PAGE_SIZE = 10;
export const PAGE_PAGE_SIZE = 20;
/** Same cadence as the topbar bell, so the list and the bell never disagree for long. */
export const NOTIFICATION_POLL_MS = 60_000;
const ANNOUNCEMENT_MS = 4_000;

interface Loaded {
  /** In the server's order — never re-sorted here (see mergeRefresh). */
  items: NotificationItem[];
  /** Where "Load more" continues from: the end of what's loaded. */
  nextCursor: string | null;
}

/**
 * Folds a freshly fetched first page into what's loaded.
 *
 * The fetched page is authoritative for the window it covers: from the top
 * of the list down to the row it ENDS on. A loaded row above that point
 * that the page no longer contains is gone (read under Unread only, deleted,
 * or bumped to the top — in which case it's in the page), so it's dropped;
 * loaded rows below it (pages the user reached with "Load more") are kept,
 * with their own cursor.
 *
 * The window is located by the page's LAST row, not by any overlap: a row
 * bumped from far down to the top overlaps too, and measuring from it would
 * throw away every live row between its old and new position. If the page's
 * last row isn't loaded at all, the two lists can't be stitched safely (more
 * new rows arrived than one page holds, or everything loaded was read
 * elsewhere), so the page replaces the list and Load more continues from it.
 *
 * Nothing is re-sorted on the client: the server orders by microsecond
 * timestamps the client can't see, and mark-all's bound is the first row,
 * so a client re-sort could put an older row first and leave the newest one
 * outside the bound.
 */
export function mergeRefresh(prev: Loaded | null, page: NotificationPage): Loaded {
  const replace = { items: page.items, nextCursor: page.nextCursor };
  const last = page.items[page.items.length - 1];
  if (!prev || page.nextCursor === null || !last) return replace;
  const windowEnd = prev.items.findIndex((n) => n.id === last.id);
  if (windowEnd === -1) return replace;
  const fresh = new Set(page.items.map((n) => n.id));
  const tail = prev.items.slice(windowEnd + 1).filter((n) => !fresh.has(n.id));
  return {
    items: [...page.items, ...tail],
    nextCursor: tail.length > 0 ? prev.nextCursor : page.nextCursor,
  };
}

/**
 * One notification list (the pane and the page both use it): first page,
 * Load more, background refreshes that merge into what's loaded, per-row
 * read/unread, and a bounded "mark all as read".
 */
export function useNotificationFeed(
  tab: NotificationTab,
  {
    unreadOnly = false,
    active = true,
    pageSize = PAGE_PAGE_SIZE,
  }: { unreadOnly?: boolean; active?: boolean; pageSize?: number } = {},
) {
  // null = the first page hasn't arrived. First-load and later errors are
  // separate, so a failed refresh never replaces rows on screen, and each
  // retry repeats what actually failed.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
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
    setLoaded(null);
    setFirstError(false);
    setMoreError(false);
    setAnnouncement('');
    try {
      const page = await listNotifications({ tab, unreadOnly, limit: pageSize });
      if (gen !== generation.current) return;
      setLoaded({ items: page.items, nextCursor: page.nextCursor });
      setUnreadCount(page.unreadCount);
    } catch {
      if (gen === generation.current) setFirstError(true);
    }
  }, [tab, unreadOnly, pageSize]);

  const refresh = useCallback(async () => {
    const gen = generation.current;
    try {
      const page = await listNotifications({ tab, unreadOnly, limit: pageSize });
      if (gen !== generation.current) return;
      setUnreadCount(page.unreadCount);
      setLoaded((prev) => mergeRefresh(prev, page));
      setFirstError(false);
    } catch {
      // A failed background refresh changes nothing: the rows on screen are
      // still what the server last said, and the next trigger retries.
    }
  }, [tab, unreadOnly, pageSize]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  // Only while someone is looking (`active`): the closed pane stays mounted
  // to keep its rows, but it doesn't poll. Becoming active again refreshes
  // once, so a reopened pane is never staler than the bell beside it.
  const wasActive = useRef(active);
  useEffect(() => {
    if (!active) {
      wasActive.current = false;
      return undefined;
    }
    if (!wasActive.current) {
      wasActive.current = true;
      void refresh();
    }
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
  }, [refresh, active]);

  // A spoken confirmation clears itself, so the next identical one is
  // announced again instead of being ignored as unchanged text.
  useEffect(() => {
    if (!announcement) return undefined;
    const t = window.setTimeout(() => setAnnouncement(''), ANNOUNCEMENT_MS);
    return () => window.clearTimeout(t);
  }, [announcement]);

  const loadMore = useCallback(async () => {
    const cursor = loaded?.nextCursor;
    if (!cursor || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await listNotifications({ tab, unreadOnly, limit: pageSize, cursor });
      if (gen !== generation.current) return;
      setLoaded((prev) => {
        const items = prev?.items ?? [];
        const seen = new Set(items.map((n) => n.id));
        return { items: [...items, ...page.items.filter((n) => !seen.has(n.id))], nextCursor: page.nextCursor };
      });
      setUnreadCount(page.unreadCount);
    } catch {
      if (gen === generation.current) setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [loaded?.nextCursor, loadingMore, tab, unreadOnly, pageSize]);

  const setRead = useCallback(async (n: NotificationItem, read: boolean) => {
    if (n.read === read) return;
    const readAt = read ? new Date().toISOString() : null;
    const patch = (prev: Loaded | null) =>
      prev && { ...prev, items: prev.items.map((x) => (x.id === n.id ? { ...x, read, readAt } : x)) };
    setLoaded(patch);
    setUnreadCount((c) => Math.max(0, c + (read ? -1 : 1)));
    try {
      await (read ? markNotificationRead(n.id) : markNotificationUnread(n.id));
      announceNotificationsChanged();
    } catch {
      // Put the row back the way the server still has it.
      setLoaded((prev) => prev && { ...prev, items: prev.items.map((x) => (x.id === n.id ? n : x)) });
      setUnreadCount((c) => Math.max(0, c + (read ? 1 : -1)));
    }
  }, []);

  const markAllRead = useCallback(async () => {
    const newest = loaded?.items[0];
    if (!newest) return;
    setMarkAllError(false);
    try {
      // Bounded by the newest row on screen: one that lands meanwhile stays unread.
      const updated = await markAllNotificationsRead(newest.cursor, tab);
      // Every loaded row is at or below that bound and in this tab, so every
      // one of them is read now. Under Unread only they leave the list.
      const readAt = new Date().toISOString();
      setLoaded((prev) =>
        !prev
          ? prev
          : unreadOnly
            ? { items: [], nextCursor: null }
            : { ...prev, items: prev.items.map((x) => (x.read ? x : { ...x, read: true, readAt })) },
      );
      setAnnouncement(updated === 1 ? 'Marked 1 notification as read' : `Marked ${updated} notifications as read`);
      announceNotificationsChanged();
    } catch {
      setMarkAllError(true);
    }
  }, [loaded, tab, unreadOnly]);

  return {
    items: loaded?.items ?? null,
    nextCursor: loaded?.nextCursor ?? null,
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
