import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  disconnectJira,
  getJiraConnectionStatus,
  refreshJiraSync,
} from '@/data/jiraApi';
import { setJiraConnection } from '@/lib/jiraStore';
import type { JiraConnectionStatus } from '@/types/jira';
import { JiraConnectionPanel } from './JiraConnectionPanel';

jest.mock('@/data/jiraApi', () => ({
  refreshJiraSync: jest.fn(),
  disconnectJira: jest.fn(),
  getJiraConnectionStatus: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({ setJiraConnection: jest.fn() }));

function status(
  overrides: Partial<JiraConnectionStatus> = {},
): JiraConnectionStatus {
  return {
    connected: true,
    accountName: 'Max Chen',
    accountEmail: 'max@northwind.dev',
    site: 'northwind.atlassian.net',
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    issueCount: 6,
    projectCount: 3,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('JiraConnectionPanel', () => {
  it('renders the connected account row and live stats from the connection prop', () => {
    render(<JiraConnectionPanel connection={status()} />);

    expect(screen.getByText('Max Chen')).toBeInTheDocument();
    expect(
      screen.getByText('max@northwind.dev · northwind.atlassian.net'),
    ).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  // The "poll interval" stat and the "Pause sync" button that used to sit
  // here described a background sync that has never existed — no timer, in
  // the fixture layer or the real one, ever re-read the list. They are gone
  // rather than left describing behavior the app does not have.
  it('advertises no poll interval and offers no pause, because nothing polls', () => {
    render(<JiraConnectionPanel connection={status()} />);

    expect(screen.queryByText(/poll interval/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /pause|resume/i }),
    ).not.toBeInTheDocument();
  });

  // The write banner used to list "moving, commenting, changing priority".
  // Only the first two exist — jiraApi.ts's whole write surface is
  // transitionJiraTicket and postJiraComment — so the third was a capability
  // claim made by the one panel that exists to be accurate about them.
  it('names only the two writes that exist, and no priority write', () => {
    render(<JiraConnectionPanel connection={status()} />);

    expect(screen.queryByText(/changing priority/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/moving a ticket through its workflow, and/i),
    ).toBeInTheDocument();
  });

  it('Refresh now calls refreshJiraSync and pushes the result into jiraStore', async () => {
    const refreshed = status({ lastSyncAt: '2026-01-01T00:05:00.000Z' });
    jest.mocked(refreshJiraSync).mockResolvedValue(refreshed);
    render(<JiraConnectionPanel connection={status()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    await waitFor(() =>
      expect(setJiraConnection).toHaveBeenCalledWith(refreshed),
    );
  });

  it('Disconnect genuinely calls disconnectJira and pushes the re-read status into jiraStore', async () => {
    jest.mocked(disconnectJira).mockResolvedValue(undefined);
    jest
      .mocked(getJiraConnectionStatus)
      .mockResolvedValue(status({ connected: false }));
    render(<JiraConnectionPanel connection={status()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(disconnectJira).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(setJiraConnection).toHaveBeenCalledWith(
        expect.objectContaining({ connected: false }),
      ),
    );
  });

  it('sync actions are disabled once disconnected', () => {
    render(<JiraConnectionPanel connection={status({ connected: false })} />);

    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });
});
