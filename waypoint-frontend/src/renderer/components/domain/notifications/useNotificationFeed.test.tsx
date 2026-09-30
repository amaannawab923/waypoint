import { act, renderHook } from '@testing-library/react';
import { listNotifications, markAllNotificationsRead } from '@/data/api';
import type { NotificationItem, NotificationPage } from '@/types/entities';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notificationEvents';
import { mergeRefresh, useNotificationFeed } from './useNotificationFeed';

jest.mock('@/data/api', () => ({
  listNotifications: jest.fn(),
  markNotificationRead: jest.fn(),
  markNotificationUnread: jest.fn(),
  markAllNotificationsRead: jest.fn(),
}));

function n(id: string, read = false): NotificationItem {
  return {
    id, recipientId: 'm1', actorId: 'm2', ticketId: null, commentId: null, runId: null, message: null,
    read, readAt: read ? '2026-01-01T00:00:00.000Z' : null, kind: 'mention', groupKey: null, payload: {},
    // Deliberately all in ONE millisecond: the server's order (microseconds)
    // is the only correct one, and nothing here may re-sort it.
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', cursor: `cur-${id}`,
  };
}
const ids = (items: NotificationItem[] | null) => (items ?? []).map((x) => x.id);
const pageOf = (items: NotificationItem[], nextCursor: string | null = null): NotificationPage => ({
  items, nextCursor, unreadCount: items.filter((x) => !x.read).length,
});

beforeEach(() => jest.clearAllMocks());

describe('mergeRefresh', () => {
  it('keeps the server order exactly, never re-sorting within a millisecond', () => {
    const merged = mergeRefresh({ items: [n('b'), n('a')], nextCursor: 'cur-a' }, pageOf([n('z'), n('b')], 'cur-b'));
    expect(ids(merged.items)).toEqual(['z', 'b', 'a']);
  });

  it('drops a loaded row inside the fresh window that the server no longer returns', () => {
    // Loaded: c, b, a, then an older page x, w. Fresh page: c, a (b was read
    // under Unread only, or deleted). b is inside the window: gone.
    const prev = { items: [n('c'), n('b'), n('a'), n('x'), n('w')], nextCursor: 'cur-w' };
    const merged = mergeRefresh(prev, pageOf([n('c'), n('a')], 'cur-a'));
    expect(ids(merged.items)).toEqual(['c', 'a', 'x', 'w']);
    expect(merged.nextCursor).toBe('cur-w'); // the loaded frontier survives
  });

  it('a last page replaces everything', () => {
    const merged = mergeRefresh({ items: [n('b'), n('a')], nextCursor: 'cur-a' }, pageOf([n('b')]));
    expect(ids(merged.items)).toEqual(['b']);
    expect(merged.nextCursor).toBeNull();
  });
});

describe('useNotificationFeed', () => {
  const first = Array.from({ length: 30 }, (_, i) => n(`p1-${String(i).padStart(2, '0')}`));
  const second = Array.from({ length: 10 }, (_, i) => n(`p2-${i}`));

  async function loadTwoPages(unreadOnly = false) {
    jest.mocked(listNotifications).mockResolvedValueOnce(pageOf(first, 'cur-p1'));
    const hook = renderHook(() => useNotificationFeed('all', unreadOnly));
    await act(async () => {});
    jest.mocked(listNotifications).mockResolvedValueOnce(pageOf(second));
    await act(async () => {
      await hook.result.current.loadMore();
    });
    expect(hook.result.current.items).toHaveLength(40);
    return hook;
  }

  it('Mark all as read turns every loaded row read, not just the first page', async () => {
    const { result } = await loadTwoPages();
    jest.mocked(markAllNotificationsRead).mockResolvedValue(40);
    jest.mocked(listNotifications).mockResolvedValue(pageOf(first.map((x) => ({ ...x, read: true })), 'cur-p1'));
    await act(async () => {
      await result.current.markAllRead();
    });
    expect(markAllNotificationsRead).toHaveBeenCalledWith('cur-p1-00', 'all');
    expect(result.current.items!.filter((x) => !x.read)).toHaveLength(0);
    expect(result.current.items).toHaveLength(40);
    expect(result.current.announcement).toBe('Marked 40 notifications as read');
  });

  it('under Unread only, Mark all as read empties the list', async () => {
    const { result } = await loadTwoPages(true);
    jest.mocked(markAllNotificationsRead).mockResolvedValue(40);
    jest.mocked(listNotifications).mockResolvedValue(pageOf([]));
    await act(async () => {
      await result.current.markAllRead();
    });
    expect(result.current.items).toEqual([]);
  });

  it('under Unread only, a refresh drops rows read somewhere else', async () => {
    jest.mocked(listNotifications).mockResolvedValueOnce(pageOf([n('b'), n('a')]));
    const { result } = renderHook(() => useNotificationFeed('all', true));
    await act(async () => {});
    jest.mocked(listNotifications).mockResolvedValueOnce(pageOf([n('a')]));
    await act(async () => {
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
    });
    expect(ids(result.current.items)).toEqual(['a']);
  });

  it('a failed Load more says so and retries Load more; loaded rows stay', async () => {
    jest.mocked(listNotifications).mockResolvedValueOnce(pageOf(first, 'cur-p1'));
    const { result } = renderHook(() => useNotificationFeed('all'));
    await act(async () => {});
    jest.mocked(listNotifications).mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.moreError).toBe(true);
    expect(result.current.items).toHaveLength(30);
    jest.mocked(listNotifications).mockResolvedValueOnce(pageOf(second));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.moreError).toBe(false);
    expect(result.current.items).toHaveLength(40);
  });

  it('a failed background refresh leaves the rows on screen and no error', async () => {
    jest.mocked(listNotifications).mockResolvedValueOnce(pageOf([n('a')]));
    const { result } = renderHook(() => useNotificationFeed('all'));
    await act(async () => {});
    jest.mocked(listNotifications).mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(ids(result.current.items)).toEqual(['a']);
    expect(result.current.firstError).toBe(false);
    expect(result.current.moreError).toBe(false);
  });

  it('clears its announcement, so the same one is spoken again next time', async () => {
    jest.useFakeTimers();
    try {
      jest.mocked(listNotifications).mockResolvedValue(pageOf([n('a')]));
      jest.mocked(markAllNotificationsRead).mockResolvedValue(1);
      const { result } = renderHook(() => useNotificationFeed('all'));
      await act(async () => {});
      await act(async () => {
        await result.current.markAllRead();
      });
      expect(result.current.announcement).toBe('Marked 1 notification as read');
      await act(async () => {
        jest.advanceTimersByTime(4_000);
      });
      expect(result.current.announcement).toBe('');
    } finally {
      jest.useRealTimers();
    }
  });
});
