import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { CAPABILITIES } from '@/capabilities';
import {
  getTicket,
  listAgents,
  listMembers,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
} from '@/data/api';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notificationEvents';
import type { NotificationItem, NotificationPage } from '@/types/entities';
import Notifications from './Notifications';

jest.mock('@/data/api', () => ({
  listNotifications: jest.fn(),
  listMembers: jest.fn(),
  listAgents: jest.fn(),
  markNotificationRead: jest.fn(),
  markNotificationUnread: jest.fn(),
  markAllNotificationsRead: jest.fn(),
  getTicket: jest.fn(),
}));

function note(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    recipientId: 'm1',
    actorId: 'm2',
    ticketId: null,
    commentId: null,
    runId: null,
    message: null,
    read: false,
    readAt: null,
    kind: 'mention',
    groupKey: null,
    payload: { v: 1, ticketKey: 'WP-1', ticketTitle: 'Auth flow' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cursor: 'cur-n1',
    ...overrides,
  };
}

function page(
  items: NotificationItem[],
  nextCursor: string | null = null,
): NotificationPage {
  return {
    items,
    nextCursor,
    unreadCount: items.filter((n) => !n.read).length,
  };
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.hash}</p>;
}

function mount(first: NotificationPage = page([])) {
  jest.mocked(listNotifications).mockResolvedValue(first);
  jest
    .mocked(listMembers)
    .mockResolvedValue([
      { id: 'm2', fullName: 'Maya Patel', avatarColor: '#000' } as never,
    ]);
  jest.mocked(listAgents).mockResolvedValue([]);
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <Routes>
        <Route path="/notifications" element={<Notifications />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

describe('Notifications page', () => {
  // The register entry is only honest if the page that makes the promise
  // renders it — deleting the <NotWired/> must fail a test.
  it("discloses that only @mentions produce notifications, in the register's own words", async () => {
    mount();
    await act(async () => {});
    expect(
      screen.getByText(CAPABILITIES['notifications.production'].note),
    ).toBeInTheDocument();
  });

  it('says what will actually arrive in the empty states, and filters tabs on the server', async () => {
    mount();
    await act(async () => {});
    expect(
      screen.getByText(
        'When someone @mentions you in a comment, it shows up here.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/as things happen/)).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Mentions' }));
    });
    expect(listNotifications).toHaveBeenLastCalledWith({
      tab: 'mentions',
      unreadOnly: false,
      limit: 30,
    });
    expect(screen.getByText('No mentions')).toBeInTheDocument();
  });

  it('Unread only asks the server for unread rows', async () => {
    mount();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Unread only'));
    });
    expect(listNotifications).toHaveBeenLastCalledWith({
      tab: 'all',
      unreadOnly: true,
      limit: 30,
    });
    expect(screen.getByText('No unread notifications')).toBeInTheDocument();
  });

  it('opens a mention at the exact comment and tells the shell it was read', async () => {
    const listener = jest.fn();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, listener);
    jest.mocked(markNotificationRead).mockResolvedValue(undefined);
    jest
      .mocked(getTicket)
      .mockResolvedValue({ projectId: 'p1', identifier: 'WP-1' } as never);
    mount(page([note({ ticketId: 't1', commentId: 'c9' })]));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: /Maya Patel mentioned you on WP-1 Auth flow, unread/,
        }),
      );
    });
    expect(markNotificationRead).toHaveBeenCalledWith('n1');
    expect(listener).toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/projects/p1/tickets/WP-1#comment-c9',
    );
    window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, listener);
  });

  it('opens a session notification at the session, even when the run is on a ticket', async () => {
    jest.mocked(markNotificationRead).mockResolvedValue(undefined);
    mount(
      page([
        note({
          kind: 'agent_blocked',
          ticketId: 't1',
          runId: 'run-7',
          payload: {},
          message: 'is blocked',
        }),
      ]),
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /is blocked, unread/ }),
      );
    });
    expect(getTicket).not.toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/sessions/run-7');
  });

  it('groups rows under day headers', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    mount(
      page([
        note({ id: 'a' }),
        note({ id: 'b', updatedAt: yesterday, cursor: 'cur-b' }),
      ]),
    );
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Yesterday' }),
    ).toBeInTheDocument();
  });

  it('marks one row read and unread from its own action', async () => {
    jest.mocked(markNotificationRead).mockResolvedValue(undefined);
    jest.mocked(markNotificationUnread).mockResolvedValue(undefined);
    mount(page([note()]));
    await act(async () => {});
    // The server now has it read, so the refresh the change triggers agrees.
    jest
      .mocked(listNotifications)
      .mockResolvedValue(
        page([note({ read: true, readAt: new Date().toISOString() })]),
      );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Mark as read:/ }));
    });
    expect(markNotificationRead).toHaveBeenCalledWith('n1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Mark as unread:/ }));
    });
    expect(markNotificationUnread).toHaveBeenCalledWith('n1');
  });

  // A background refresh must not collapse what the user paged down to.
  it('keeps loaded pages when a refresh arrives, adding new rows on top', async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString();
    mount(
      page(
        [
          note({
            id: 'a',
            cursor: 'cur-a',
            updatedAt: t0,
            payload: { ticketKey: 'WP-1', ticketTitle: 'First' },
          }),
        ],
        'cur-a',
      ),
    );
    await act(async () => {});
    jest
      .mocked(listNotifications)
      .mockResolvedValueOnce(
        page([
          note({
            id: 'b',
            cursor: 'cur-b',
            updatedAt: new Date(Date.now() - 120_000).toISOString(),
            payload: { ticketKey: 'WP-2', ticketTitle: 'Second' },
          }),
        ]),
      );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    expect(listNotifications).toHaveBeenLastCalledWith({
      tab: 'all',
      unreadOnly: false,
      limit: 30,
      cursor: 'cur-a',
    });

    jest
      .mocked(listNotifications)
      .mockResolvedValueOnce(
        page([
          note({
            id: 'new',
            cursor: 'cur-new',
            payload: { ticketKey: 'WP-3', ticketTitle: 'Newest' },
          }),
          note({
            id: 'a',
            cursor: 'cur-a',
            updatedAt: t0,
            payload: { ticketKey: 'WP-1', ticketTitle: 'First' },
          }),
          // More rows exist below this page, as on a real list.
        ], 'cur-a'),
      );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    const titles = screen
      .getAllByRole('button', { name: /^Maya Patel mentioned you on/ })
      .map((b) => b.getAttribute('aria-label'));
    expect(titles.map((t) => t?.match(/WP-\d/)?.[0])).toEqual([
      'WP-3',
      'WP-1',
      'WP-2',
    ]);
  });

  // A notification that lands while you read must not be cleared unseen:
  // mark-all is bounded by the newest row on screen, and says what it did.
  it('marks all read up to the newest row on screen, and announces the count', async () => {
    jest.mocked(markAllNotificationsRead).mockResolvedValue(2);
    mount(
      page([
        note({ id: 'new', cursor: 'cur-new' }),
        note({ id: 'old', cursor: 'cur-old' }),
      ]),
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    });
    expect(markAllNotificationsRead).toHaveBeenCalledWith('cur-new', 'all');
    expect(
      screen.getByText('Marked 2 notifications as read'),
    ).toBeInTheDocument();
  });

  it('says so when mark all as read fails, instead of failing silently', async () => {
    jest
      .mocked(markAllNotificationsRead)
      .mockRejectedValue(new Error('offline'));
    mount(page([note()]));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Couldn’t mark them as read',
    );
  });

  it('shows a retryable error when the first load fails, and never an empty state', async () => {
    jest.mocked(listNotifications).mockRejectedValueOnce(new Error('offline'));
    jest.mocked(listMembers).mockResolvedValue([]);
    jest.mocked(listAgents).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <Notifications />
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(screen.queryByText('You’re all caught up')).not.toBeInTheDocument();
    const alert = screen.getByRole('alert');
    jest.mocked(listNotifications).mockResolvedValue(page([note()]));
    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    });
    expect(
      screen.getByRole('button', { name: /^Someone mentioned you on WP-1/ }),
    ).toBeInTheDocument();
  });
});
