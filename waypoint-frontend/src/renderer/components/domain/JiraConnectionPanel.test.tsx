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
  // originally written to pin shut. jiraApi.ts now genuinely exposes five
  // writes — transitionJiraTicket, postJiraComment, setJiraTicketPriority,
  // setJiraTicketAssignee and uploadJiraAttachment — so the banner names five,
  // and the check moves with it rather than being deleted: what it guards is
  // that the count on screen matches the count in the data layer, in either
  // direction.
  it('names exactly the five writes that exist, attaching among them', () => {
    render(<JiraConnectionPanel connection={status()} />);

    expect(
      screen.getByText(
        /moving a ticket through its workflow, posting a comment, changing its priority, reassigning it, and attaching a file/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/those five are the whole set/i)).toBeVisible();
  });

  // The other direction of the same defect. Uploading an attachment IS built
  // now, so the "Not built yet" list must no longer say it isn't — a list of
  // missing capabilities that has gone stale misleads exactly as much as a
  // banner claiming one that does not exist. The old counts are checked for
  // the same reason: "those four are the whole set" left standing after a
  // fifth write shipped would be just as wrong.
  it('no longer says attachments cannot be uploaded, because they can', () => {
    render(<JiraConnectionPanel connection={status()} />);

    expect(screen.queryByText(/Uploading attachments/i)).toBeNull();
    expect(screen.queryByText(/those two are the whole set/i)).toBeNull();
    expect(screen.queryByText(/those three are the whole set/i)).toBeNull();
    expect(screen.queryByText(/those four are the whole set/i)).toBeNull();
  });

  // What is still genuinely missing stays listed. Removing one true entry
  // from this list must not turn into quietly emptying it.
  it('still says plainly what is not built', () => {
    render(<JiraConnectionPanel connection={status()} />);

    expect(screen.getByText(/Rich-text authoring/i)).toBeInTheDocument();
    expect(screen.getByText(/Background sync/i)).toBeInTheDocument();
    expect(screen.getByText(/Creating issues/i)).toBeInTheDocument();
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
