import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
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
