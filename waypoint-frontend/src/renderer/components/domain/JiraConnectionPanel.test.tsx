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
    accountId: '5f8a',
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

  // This assertion is the capability register, not decoration. The banner
  // once listed a priority write that did not exist, which this test was
  // originally written to pin shut. jiraApi.ts now genuinely exposes four
  // writes — transitionJiraTicket, postJiraComment, setJiraTicketPriority and
  // setJiraTicketAssignee — so the banner names four, and the check moves with
  // it rather than being deleted: what it guards is that the count on screen
  // matches the count in the data layer, in either direction.
  it('names exactly the four writes that exist, reassigning among them', () => {
    render(<JiraConnectionPanel connection={status()} />);

    expect(
      screen.getByText(
        /moving a ticket through its workflow, posting a comment, changing its priority, and reassigning it/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/those four are the whole set/i)).toBeVisible();
  });

  // Uploading an attachment is still genuinely not built, so the banner must
  // not have quietly grown into a claim about it, and the "Not built yet"
  // list must still say so plainly. The stale counts are checked too: a
  // banner left reading "three" after a fourth write shipped is the same
  // defect as one claiming a write that does not exist.
  it('does not claim a write it does not have', () => {
    render(<JiraConnectionPanel connection={status()} />);

    expect(screen.queryByText(/those two are the whole set/i)).toBeNull();
    expect(screen.queryByText(/those three are the whole set/i)).toBeNull();
    expect(screen.getByText(/Uploading attachments/i)).toBeInTheDocument();
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
