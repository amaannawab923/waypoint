import '@testing-library/jest-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { CAPABILITIES } from '@/capabilities';
import {
  getTicket,
  listAgents,
  listMembers,
  listNotifications,
  listProjects,
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
  listProjects: jest.fn(),
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
  jest.mocked(listProjects).mockResolvedValue([
    { id: 'p1', name: 'Compass Web', coverGradient: ['#111111', '#222222'] } as never,
  ]);
  const utils = render(tree(onClose));
  return { ...utils, onClose, reopen: (open: boolean) => utils.rerender(tree(onClose, open)) };
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  resetCopilotOpenStateForTests();
});

describe('NotificationsPane', () => {
  it('opens as a docked side pane with its rows and focus inside, without the page\'s notice', async () => {
    mount();
    await act(async () => {});
    const pane = screen.getByRole('dialog', { name: 'Notifications' });
    expect(pane).toHaveStyle({ right: '0px' });
    expect(pane).toHaveAttribute('data-shortcut-guard');
    expect(pane).toHaveFocus();
    expect(screen.getByText('1 new')).toBeInTheDocument();
    // The pane shows only what's sent and promises nothing more (its empty
    // states name exactly those kinds); the fuller note lives on the page.
    expect(
      screen.queryByText(CAPABILITIES['notifications.production'].note),
    ).not.toBeInTheDocument();
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

  it('filters to unread from its switch, and links to notification settings', async () => {
    const { onClose } = mount();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Unread only' }));
    });
    expect(listNotifications).toHaveBeenLastCalledWith({ tab: 'all', unreadOnly: true, limit: 10 });
    fireEvent.click(screen.getByRole('button', { name: 'Notification settings' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/profile/notifications');
  });

  it('starts with 10 and grows 10 at a time with "Show more", until there is no more', async () => {
    const batch = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...row, id: `n${from + i}`, cursor: `cur-${from + i}` }));
    mount();
    jest.mocked(listNotifications).mockReset();
    jest.mocked(listNotifications).mockResolvedValueOnce({ items: batch(0, 10), nextCursor: 'cur-9', unreadCount: 25 });
    // Reopen so the first load uses the batch above.
    cleanup();
    render(tree(jest.fn()));
    await act(async () => {});
    expect(listNotifications).toHaveBeenLastCalledWith({ tab: 'all', unreadOnly: false, limit: 10 });
    expect(screen.getAllByRole('button', { name: /^Maya Patel mentioned you/ })).toHaveLength(10);
    expect(screen.getByText('Showing 10')).toBeInTheDocument();

    jest.mocked(listNotifications).mockResolvedValueOnce({ items: batch(10, 10), nextCursor: 'cur-19', unreadCount: 25 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    });
    expect(listNotifications).toHaveBeenLastCalledWith({ tab: 'all', unreadOnly: false, limit: 10, cursor: 'cur-9' });
    expect(screen.getAllByRole('button', { name: /^Maya Patel mentioned you/ })).toHaveLength(20);
    expect(screen.getByText('Showing 20')).toBeInTheDocument();

    jest.mocked(listNotifications).mockResolvedValueOnce({ items: batch(20, 5), nextCursor: null, unreadCount: 25 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    });
    expect(screen.getAllByRole('button', { name: /^Maya Patel mentioned you/ })).toHaveLength(25);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    expect(screen.getByText('That’s everything.')).toBeInTheDocument();
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
      limit: 10,
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
    // The kept rows are there at once — no skeleton...
    expect(screen.getByRole('button', { name: /^Maya Patel mentioned you/ })).toBeInTheDocument();
    await act(async () => {});
    // ...and one background refresh brings them up to date with the bell.
    expect(listNotifications).toHaveBeenCalledTimes(2);
  });

  it('reopens on the tab last chosen on the full page', async () => {
    const { reopen } = mount();
    await act(async () => {});
    reopen(false);
    window.localStorage.setItem('waypoint.notifications.tab', 'mentions');
    await act(async () => {
      reopen(true);
    });
    expect(screen.getByRole('tab', { name: 'Mentions' })).toHaveAttribute('aria-selected', 'true');
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

  it('leaves focus where ⌘K put it (the search box), not back on the bell', async () => {
    const search = document.createElement('input');
    document.body.appendChild(search);
    let reopenRef: (open: boolean) => void = () => {};
    // Same batch as the real app: the palette's input autofocuses, then the
    // pane closes.
    const onClose = jest.fn(() => {
      search.focus();
      reopenRef(false);
    });
    const { reopen } = mount(onClose);
    reopenRef = reopen;
    await act(async () => {});
    act(() => {
      fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    });
    expect(search).toHaveFocus();
    search.remove();
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
