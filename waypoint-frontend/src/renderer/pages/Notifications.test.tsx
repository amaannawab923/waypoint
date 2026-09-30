import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { CAPABILITIES } from '@/capabilities';
import {
  getTicket,
  listAgents,
  listMembers,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/data/api';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notificationEvents';
import type { NotificationItem, NotificationPage } from '@/types/entities';
import Notifications, { notificationSentence } from './Notifications';

jest.mock('@/data/api', () => ({
  listNotifications: jest.fn(),
  listMembers: jest.fn(),
  listAgents: jest.fn(),
  markNotificationRead: jest.fn(),
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cursor: 'cur-n1',
    ...overrides,
  };
}

function page(items: NotificationItem[], nextCursor: string | null = null): NotificationPage {
  return { items, nextCursor, unreadCount: items.filter((n) => !n.read).length };
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.hash}</p>;
}

function mount(first: NotificationPage = page([])) {
  jest.mocked(listNotifications).mockResolvedValue(first);
  jest.mocked(listMembers).mockResolvedValue([]);
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

beforeEach(() => jest.clearAllMocks());

describe('Notifications page', () => {
  // The register entry is only honest if the page that makes the promise
  // renders it — deleting the <NotWired/> must fail a test.
  it("discloses that only @mentions produce notifications, in the register's own words", async () => {
    mount();
    await act(async () => {});
    expect(screen.getByText(CAPABILITIES['notifications.production'].note)).toBeInTheDocument();
  });

  it('says what will actually arrive in both empty states, not "as things happen"', async () => {
    mount();
    await act(async () => {});
    expect(screen.getByText('When someone @mentions you in a comment, it will show up here.')).toBeInTheDocument();
    expect(screen.queryByText(/as things happen/)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Mentions' }));
    });
    expect(listNotifications).toHaveBeenLastCalledWith({ tab: 'mentions', limit: 30 });
    expect(screen.getByText('No mentions')).toBeInTheDocument();
  });

  it('opens a mention at the exact comment and tells the shell it was read', async () => {
    const listener = jest.fn();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, listener);
    jest.mocked(markNotificationRead).mockResolvedValue(undefined);
    jest.mocked(getTicket).mockResolvedValue({ projectId: 'p1', identifier: 'WP-1' } as never);
    mount(page([note({ ticketId: 't1', commentId: 'c9' })]));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText(/mentioned you on WP-1 Auth flow/));
    });
    expect(markNotificationRead).toHaveBeenCalledWith('n1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/p1/tickets/WP-1#comment-c9');
    window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, listener);
  });

  it('refetches when the window regains focus, in step with the bell', async () => {
    mount();
    await act(async () => {});
    expect(listNotifications).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(listNotifications).toHaveBeenCalledTimes(2);
  });

  it('loads the next page from the cursor and appends it', async () => {
    mount(page([note({ id: 'a', cursor: 'cur-a', payload: { ticketKey: 'WP-1', ticketTitle: 'First' } })], 'cur-a'));
    await act(async () => {});
    jest.mocked(listNotifications).mockResolvedValue(
      page([note({ id: 'b', cursor: 'cur-b', payload: { ticketKey: 'WP-2', ticketTitle: 'Second' } })]),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    expect(listNotifications).toHaveBeenLastCalledWith({ tab: 'all', limit: 30, cursor: 'cur-a' });
    expect(screen.getByText(/WP-1 First/)).toBeInTheDocument();
    expect(screen.getByText(/WP-2 Second/)).toBeInTheDocument();
    expect(screen.getByText('That’s everything.')).toBeInTheDocument();
  });

  // A notification that lands while you read must not be cleared unseen:
  // mark-all is bounded by the newest row on screen.
  it('marks all read up to the newest row on screen, in the current tab', async () => {
    jest.mocked(markAllNotificationsRead).mockResolvedValue(2);
    mount(page([note({ id: 'new', cursor: 'cur-new' }), note({ id: 'old', cursor: 'cur-old' })]));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    });
    expect(markAllNotificationsRead).toHaveBeenCalledWith('cur-new', 'all');
  });

  it('says the row is unread in its accessible name, not with a silent dot', async () => {
    mount(page([note()]));
    await act(async () => {});
    expect(screen.getByRole('button', { name: /mentioned you on WP-1 Auth flow, unread/ })).toBeInTheDocument();
  });
});

describe('notificationSentence', () => {
  it('renders from the payload, so a renamed ticket reads right', () => {
    expect(notificationSentence(note())).toBe('mentioned you on WP-1 Auth flow');
    expect(notificationSentence(note({ kind: 'reply' }))).toBe('replied to your comment on WP-1 Auth flow');
  });

  it('falls back to the frozen message on rows written before the payload existed', () => {
    expect(notificationSentence(note({ payload: {}, message: 'mentioned you on "Old title"' }))).toBe(
      'mentioned you on "Old title"',
    );
  });
});
