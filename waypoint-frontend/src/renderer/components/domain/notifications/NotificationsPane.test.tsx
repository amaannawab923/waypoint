import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { CAPABILITIES } from '@/capabilities';
import {
  getTicket,
  listAgents,
  listMembers,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '@/data/api';
import {
  resetCopilotOpenStateForTests,
  setCopilotOpenState,
} from '@/lib/copilotOpenStore';
import type { NotificationItem } from '@/types/entities';
import { NotificationsPane } from './NotificationsPane';

jest.mock('@/data/api', () => ({
  listNotifications: jest.fn(),
  listMembers: jest.fn(),
  listAgents: jest.fn(),
  markNotificationRead: jest.fn(),
  markNotificationUnread: jest.fn(),
  markAllNotificationsRead: jest.fn(),
  getTicket: jest.fn(),
}));

const row: NotificationItem = {
  id: 'n1',
  recipientId: 'm1',
  actorId: 'm2',
  ticketId: 't1',
  commentId: 'c1',
  runId: null,
  message: null,
  read: false,
  readAt: null,
  kind: 'mention',
  groupKey: 'mention:c1',
  payload: { v: 1, ticketKey: 'WP-1', ticketTitle: 'Auth flow' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cursor: 'cur-n1',
};

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.hash}</p>;
}

function tree(onClose: () => void, open = true) {
  return (
    <MemoryRouter initialEntries={['/your-work']}>
      <button id="bell" type="button">
        bell
      </button>
      <main data-testid="outside">page</main>
      <NotificationsPane open={open} onClose={onClose} bellId="bell" />
      <Routes>
        <Route path="/your-work" element={null} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}

function mount(onClose = jest.fn()) {
  jest.mocked(listNotifications).mockResolvedValue({ items: [row], nextCursor: null, unreadCount: 1 });
  jest.mocked(listMembers).mockResolvedValue([{ id: 'm2', fullName: 'Maya Patel', avatarColor: '#000' } as never]);
  jest.mocked(listAgents).mockResolvedValue([]);
  const utils = render(tree(onClose));
  return { ...utils, onClose, reopen: (open: boolean) => utils.rerender(tree(onClose, open)) };
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  resetCopilotOpenStateForTests();
});

describe('NotificationsPane', () => {
  it('opens as a docked side pane with its rows, the notice, and focus inside', async () => {
    mount();
    await act(async () => {});
    const pane = screen.getByRole('dialog', { name: 'Notifications' });
    expect(pane).toHaveStyle({ right: '0px' });
    expect(pane).toHaveAttribute('data-shortcut-guard');
    expect(pane).toHaveFocus();
    expect(screen.getByText('1 unread')).toBeInTheDocument();
    expect(
      screen.getByText(CAPABILITIES['notifications.production'].note),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /^Maya Patel mentioned you on WP-1 Auth flow/,
      }),
    ).toBeInTheDocument();
  });

  it('docks beside Copilot instead of under it', async () => {
    act(() => setCopilotOpenState(true));
    mount();
    await act(async () => {});
    expect(
      screen.getByRole('dialog', { name: 'Notifications' }),
    ).not.toHaveStyle({ right: '0px' });
  });

  it('closes on Escape from inside, on a click elsewhere, and on its × — but a bell click is left to the bell', async () => {
    const { onClose } = mount();
    await act(async () => {});
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Notifications' }), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByText('bell'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(
      screen.getByRole('button', { name: 'Close notifications' }),
    );
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('expands to the full page', async () => {
    const { onClose } = mount();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Open full page' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/notifications');
  });

  it('opens a row at its exact comment, marks it read, and closes', async () => {
    jest.mocked(markNotificationRead).mockResolvedValue(undefined);
    jest
      .mocked(getTicket)
      .mockResolvedValue({ projectId: 'p1', identifier: 'WP-1' } as never);
    const { onClose } = mount();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /^Maya Patel mentioned you/ }),
      );
    });
    expect(markNotificationRead).toHaveBeenCalledWith('n1');
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/projects/p1/tickets/WP-1#comment-c1',
    );
  });

  it('remembers the last tab across opens', async () => {
    const first = mount();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Mentions' }));
    });
    first.unmount();
    mount();
    await act(async () => {});
    expect(screen.getByRole('tab', { name: 'Mentions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(listNotifications).toHaveBeenLastCalledWith({
      tab: 'mentions',
      unreadOnly: false,
      limit: 30,
    });
  });

  it('moves between tabs with the arrow keys', async () => {
    mount();
    await act(async () => {});
    const all = screen.getByRole('tab', { name: 'All' });
    await act(async () => {
      fireEvent.keyDown(all, { key: 'ArrowRight' });
    });
    expect(screen.getByRole('tab', { name: 'Mentions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Mentions' })).toHaveFocus();
  });

  it('keeps its rows across a close and reopen, and is inert while closed', async () => {
    const { reopen } = mount();
    await act(async () => {});
    expect(listNotifications).toHaveBeenCalledTimes(1);
    reopen(false);
    // Inert and aria-hidden: gone from the accessibility tree, as intended.
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();
    const pane = document.querySelector('[data-notifications-pane]')!;
    expect(pane).toHaveAttribute('aria-hidden', 'true');
    expect(pane).toHaveAttribute('inert');
    reopen(true);
    await act(async () => {});
    expect(listNotifications).toHaveBeenCalledTimes(1); // no refetch, no skeleton
    expect(screen.getByRole('button', { name: /^Maya Patel mentioned you/ })).toBeInTheDocument();
  });

  it('returns focus to the bell when it closes', async () => {
    const { reopen } = mount();
    await act(async () => {});
    reopen(false);
    expect(screen.getByText('bell')).toHaveFocus();
  });

  it('stops its Escape from reaching a ticket drawer underneath', async () => {
    const drawerEscape = jest.fn();
    document.addEventListener('keydown', drawerEscape);
    mount();
    await act(async () => {});
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Notifications' }), { key: 'Escape' });
    expect(drawerEscape).not.toHaveBeenCalled();
    document.removeEventListener('keydown', drawerEscape);
  });

  it('gets out of the way of ⌘K, but not of a right-click elsewhere', async () => {
    const { onClose } = mount();
    await act(async () => {});
    // jsdom has no PointerEvent; a MouseEvent-typed pointerdown carries `button`.
    fireEvent(screen.getByTestId('outside'), new MouseEvent('pointerdown', { bubbles: true, button: 2 }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps focus inside after Mark all as read, so Escape still works', async () => {
    jest.mocked(markAllNotificationsRead).mockResolvedValue(1);
    const { onClose } = mount();
    await act(async () => {});
    const button = screen.getByRole('button', { name: 'Mark all as read' });
    button.focus();
    jest.mocked(listNotifications).mockResolvedValue({ items: [{ ...row, read: true }], nextCursor: null, unreadCount: 0 });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
