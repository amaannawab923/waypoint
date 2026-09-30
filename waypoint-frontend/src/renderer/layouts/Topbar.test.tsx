import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  getCurrentUser,
  listNotifications,
  listProjects,
  listAllTickets,
  listAllDocs,
  listAllSprints,
  listAllWorkstreams,
} from '@/data/api';
import { useTheme } from '@/lib/theme';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notificationEvents';
import { Topbar } from './Topbar';

// Only what Topbar itself reads at the top of its body — CreateTicketModal
// pulls in its own separate slice of @/data/api that this file has no
// reason to also stand up just to render the header around it.
jest.mock('@/data/api', () => ({
  getCurrentUser: jest.fn(),
  listNotifications: jest.fn(),
  listProjects: jest.fn(),
  listAllTickets: jest.fn(),
  listAllDocs: jest.fn(),
  listAllSprints: jest.fn(),
  listAllWorkstreams: jest.fn(),
}));
jest.mock('@/lib/theme', () => ({ useTheme: jest.fn() }));
jest.mock('@/components/domain/CreateTicketModal', () => ({
  CreateTicketModal: () => null,
}));

function mount() {
  return render(
    <MemoryRouter>
      <Topbar
        copilotEnabled={false}
        copilotOpen={false}
        onToggleCopilot={jest.fn()}
        onOpenShortcuts={jest.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getCurrentUser).mockResolvedValue({
    id: 'mem-1',
    fullName: 'Max Chen',
    avatarColor: '#000',
  } as never);
  jest.mocked(listNotifications).mockResolvedValue([]);
  jest.mocked(listProjects).mockResolvedValue([]);
  jest.mocked(listAllTickets).mockResolvedValue([]);
  jest.mocked(listAllDocs).mockResolvedValue([]);
  jest.mocked(listAllSprints).mockResolvedValue([]);
  jest.mocked(listAllWorkstreams).mockResolvedValue([]);
});

// Found in review: this conditional (`theme === 'dark' ? <IconMoon/> :
// <IconSun/>`) shipped with zero test coverage — Topbar.tsx had no test
// file at all before this. A regression that flipped the ternary or
// dropped it back to always-sun would have shipped silently.
describe('Topbar — theme toggle icon', () => {
  it('shows the "switch to light theme" affordance while dark', () => {
    jest.mocked(useTheme).mockReturnValue(['dark', jest.fn()]);
    mount();

    expect(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Switch to dark theme' }),
    ).not.toBeInTheDocument();
  });

  it('shows the "switch to dark theme" affordance while light', () => {
    jest.mocked(useTheme).mockReturnValue(['light', jest.fn()]);
    mount();

    expect(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Switch to light theme' }),
    ).not.toBeInTheDocument();
  });

  it('calls the toggle function on click, regardless of current theme', () => {
    const toggle = jest.fn();
    jest.mocked(useTheme).mockReturnValue(['dark', toggle]);
    mount();

    screen.getByRole('button', { name: 'Switch to light theme' }).click();

    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

// ROAD-160 made the bell the shell's only unread signal, so it has to carry
// the count for sighted and screen-reader users alike, and it has to move
// when the count does — Topbar mounts once for the whole session.
describe('Topbar — notifications bell', () => {
  const unread = (id: string) => ({ id, read: false }) as never;

  beforeEach(() => {
    jest.mocked(useTheme).mockReturnValue(['dark', jest.fn()]);
  });

  it('names the unread count and shows it', async () => {
    jest.mocked(listNotifications).mockResolvedValue([unread('a'), unread('b'), { id: 'c', read: true } as never]);
    mount();
    await act(async () => {});
    const bell = screen.getByRole('button', { name: 'Notifications, 2 unread' });
    expect(bell).toHaveTextContent('2');
  });

  it('is plainly "Notifications" with nothing unread', async () => {
    mount();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Notifications' })).toHaveTextContent('');
  });

  it('caps the visible count at 9+', async () => {
    jest.mocked(listNotifications).mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => unread(`n${i}`)),
    );
    mount();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Notifications, 12 unread' })).toHaveTextContent('9+');
  });

  it.each([
    ['the window regains focus', () => window.dispatchEvent(new Event('focus'))],
    ['the Notifications page reports a change', () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT))],
  ])('refetches when %s', async (_label, fire) => {
    jest.mocked(listNotifications).mockResolvedValue([unread('a')]);
    mount();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();

    jest.mocked(listNotifications).mockResolvedValue([]);
    await act(async () => {
      fire();
    });
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });
});
