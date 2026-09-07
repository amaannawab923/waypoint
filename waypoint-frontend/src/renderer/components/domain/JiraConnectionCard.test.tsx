import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import type { JiraConnectionStatus } from '@/types/jira';
import { JiraConnectionCard } from './JiraConnectionCard';

jest.mock('@/lib/jiraStore', () => ({ useLoadedJiraConnection: jest.fn() }));

// Mocked to a bare, recognizable stand-in — MyJiraPage.tsx pulls in the rest
// of the "My work" tab's tree (jiraApi, useMyJiraQueue, JiraTicketDrawer…)
// purely to define one already-exported component, and none of that belongs
// in a test of this card. The real LiveSyncIndicator's own render logic is
// covered by MyJiraPage.test.tsx; what this file needs to know is only that
// it is reused, not reimplemented — see the assertion below that checks
// `lastSyncAt` was actually threaded through.
jest.mock('@/pages/jira/MyJiraPage', () => ({
  LiveSyncIndicator: ({ lastSyncAt }: { lastSyncAt: string | null }) => (
    <span data-testid="live-sync-indicator">{lastSyncAt ?? 'unsynced'}</span>
  ),
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

function connection(
  overrides: Partial<JiraConnectionStatus> = {},
): JiraConnectionStatus {
  return {
    connected: true,
    accountName: 'Max Chen',
    accountEmail: 'max@northwind.dev',
    accountId: '5f8a',
    site: 'waypoint123.atlassian.net',
    lastSyncAt: '2026-09-07T10:00:00.000Z',
    issueCount: 12,
    projectCount: 3,
    countsTruncated: false,
    ...overrides,
  };
}

function mount(status: JiraConnectionStatus | undefined) {
  jest.mocked(useLoadedJiraConnection).mockReturnValue(status);
  const onConnectClick = jest.fn();
  render(
    <MemoryRouter>
      <JiraConnectionCard onConnectClick={onConnectClick} />
    </MemoryRouter>,
  );
  return { onConnectClick };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('JiraConnectionCard — connected', () => {
  it('shows the account, the reused sync indicator, and the issue count', () => {
    mount(connection());

    expect(screen.getByText('Max Chen')).toBeInTheDocument();
    expect(screen.getByText('waypoint123.atlassian.net')).toBeInTheDocument();
    expect(screen.getByTestId('live-sync-indicator')).toHaveTextContent(
      '2026-09-07T10:00:00.000Z',
    );
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  // Mirrors JiraConnectionPanel.tsx's own "+" suffix for a page-capped read
  // — this card must not silently drop that caveat just because it renders
  // the count in a smaller space.
  it('appends the "+" suffix when the counts are capped', () => {
    mount(connection({ issueCount: 500, countsTruncated: true }));

    expect(screen.getByText('500+')).toBeInTheDocument();
  });

  it('does not append "+" when the read was complete', () => {
    mount(connection({ issueCount: 12, countsTruncated: false }));

    expect(screen.queryByText('12+')).not.toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('navigates straight to the Connection tab on click', () => {
    mount(connection());

    fireEvent.click(screen.getByRole('button'));

    expect(mockNavigate).toHaveBeenCalledWith('/my-jira?tab=connection');
  });

  // The hard, non-negotiable constraint on this card: never the token, in
  // any form, connected or not. JiraConnectionStatus itself carries no such
  // field, but this pins the requirement at the render output too, so a
  // future field added to the type can't leak into this card silently.
  it('never renders anything token- or credential-shaped', () => {
    mount(connection());

    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/credential/i)).not.toBeInTheDocument();
  });
});

describe('JiraConnectionCard — not connected', () => {
  it('renders the muted "Connect Jira" slot when the store says disconnected', () => {
    mount(connection({ connected: false, accountName: '', site: '' }));

    expect(screen.getByText('Connect Jira')).toBeInTheDocument();
    expect(screen.queryByText('Max Chen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-sync-indicator')).not.toBeInTheDocument();
  });

  // Before the store's first fetch resolves, useLoadedJiraConnection returns
  // `undefined` — this must render the same muted slot rather than nothing at
  // all or a broken read of a connection that doesn't exist yet.
  it('renders the same muted slot while the connection status is still loading', () => {
    mount(undefined);

    expect(screen.getByText('Connect Jira')).toBeInTheDocument();
  });

  it('opens the wizard via the passed-in handler instead of navigating', () => {
    const { onConnectClick } = mount(connection({ connected: false }));

    fireEvent.click(screen.getByRole('button'));

    expect(onConnectClick).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
