import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CAPABILITIES } from '@/capabilities';
import {
  getTicket,
  listAgents,
  listMembers,
  listNotifications,
  markNotificationRead,
} from '@/data/api';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notificationEvents';
import type { NotificationItem } from '@/types/entities';
import Notifications from './Notifications';

jest.mock('@/data/api', () => ({
  listNotifications: jest.fn(),
  listMembers: jest.fn(),
  listAgents: jest.fn(),
  markNotificationRead: jest.fn(),
  getTicket: jest.fn(),
}));

function mount(notifications: NotificationItem[] = []) {
  jest.mocked(listNotifications).mockResolvedValue(notifications);
  jest.mocked(listMembers).mockResolvedValue([]);
  jest.mocked(listAgents).mockResolvedValue([]);
  return render(
    <MemoryRouter>
      <Notifications />
    </MemoryRouter>,
  );
}

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

  it('says what will actually arrive in both empty states, not "as things happen"', async () => {
    mount();
    await act(async () => {});
    expect(
      screen.getByText('When someone @mentions you in a comment, it will show up here.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/as things happen/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mentions' }));
    expect(screen.getByText('No mentions')).toBeInTheDocument();
  });

  // The topbar bell mounts once per session; without this event its unread
  // count would stay stale after the user reads something here.
  it('tells the shell when a notification is marked read', async () => {
    const listener = jest.fn();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, listener);
    jest.mocked(markNotificationRead).mockResolvedValue(undefined as never);
    jest.mocked(getTicket).mockResolvedValue(undefined);
    mount([
      {
        id: 'n1',
        recipientId: 'm1',
        actorId: 'm2',
        kind: 'mention',
        message: 'mentioned you on "Auth flow"',
        ticketId: null,
        read: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      } as NotificationItem,
    ]);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText(/mentioned you on/));
    });
    expect(markNotificationRead).toHaveBeenCalledWith('n1');
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, listener);
  });
});
