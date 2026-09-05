import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { disconnectJira, getJiraConnectionStatus, refreshJiraSync, setJiraSyncPaused } from '@/data/jiraApi';
import { setJiraConnection } from '@/lib/jiraStore';
import type { JiraConnectionStatus } from '@/types/jira';
import { JiraConnectionPanel } from './JiraConnectionPanel';

jest.mock('@/data/jiraApi', () => ({
  refreshJiraSync: jest.fn(),
  setJiraSyncPaused: jest.fn(),
  disconnectJira: jest.fn(),
  getJiraConnectionStatus: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({ setJiraConnection: jest.fn() }));

function status(overrides: Partial<JiraConnectionStatus> = {}): JiraConnectionStatus {
  return {
    connected: true,
    accountName: 'Max Chen',
    accountEmail: 'max@northwind.dev',
    site: 'northwind.atlassian.net',
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    issueCount: 6,
    projectCount: 3,
    pollIntervalSec: 15,
    paused: false,
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
    expect(screen.getByText('max@northwind.dev · northwind.atlassian.net')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('15s')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('Refresh now calls refreshJiraSync and pushes the result into jiraStore', async () => {
    const refreshed = status({ lastSyncAt: '2026-01-01T00:05:00.000Z' });
    jest.mocked(refreshJiraSync).mockResolvedValue(refreshed);
    render(<JiraConnectionPanel connection={status()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    await waitFor(() => expect(setJiraConnection).toHaveBeenCalledWith(refreshed));
  });

  it('Pause sync calls setJiraSyncPaused(true) and Resume sync calls it with false', async () => {
    jest.mocked(setJiraSyncPaused).mockResolvedValue(status({ paused: true }));
    const { rerender } = render(<JiraConnectionPanel connection={status({ paused: false })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause sync' }));
    await waitFor(() => expect(setJiraSyncPaused).toHaveBeenCalledWith(true));

    jest.mocked(setJiraSyncPaused).mockResolvedValue(status({ paused: false }));
    rerender(<JiraConnectionPanel connection={status({ paused: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume sync' }));
    await waitFor(() => expect(setJiraSyncPaused).toHaveBeenCalledWith(false));
  });

  it('Disconnect genuinely calls disconnectJira and pushes the re-read status into jiraStore', async () => {
    jest.mocked(disconnectJira).mockResolvedValue(undefined);
    jest.mocked(getJiraConnectionStatus).mockResolvedValue(status({ connected: false }));
    render(<JiraConnectionPanel connection={status()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(disconnectJira).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(setJiraConnection).toHaveBeenCalledWith(expect.objectContaining({ connected: false })),
    );
  });

  it('sync actions are disabled once disconnected', () => {
    render(<JiraConnectionPanel connection={status({ connected: false })} />);

    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause sync' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });
});
