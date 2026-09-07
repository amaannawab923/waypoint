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

// The tile is a single role="button" wrapper (matching ProjectCard's own
// pattern exactly, per the product owner's explicit ask that this look like
// a real project tile) with a nested, separately-clickable settings
// IconButton inside it — so `getByRole('button')` alone is ambiguous. This
// always picks the outer tile, never the inner settings control.
function getTile() {
  return screen.getAllByRole('button')[0];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('JiraConnectionCard — connected', () => {
  it('shows the account, the reused sync indicator, and the issue count', () => {
    mount(connection());

    expect(screen.getByText('Max Chen')).toBeInTheDocument();
    expect(screen.getByText('waypoint123.atlassian.net')).toBeInTheDocument();
    expect(screen.getByText('Companion project')).toBeInTheDocument();
    expect(screen.getByTestId('live-sync-indicator')).toHaveTextContent(
      '2026-09-07T10:00:00.000Z',
    );
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('issues')).toBeInTheDocument();
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

  it('singularizes "issue" for a count of exactly one', () => {
    mount(connection({ issueCount: 1, countsTruncated: false }));

    expect(screen.getByText('issue')).toBeInTheDocument();
    expect(screen.queryByText('issues')).not.toBeInTheDocument();
  });

  // Matches ProjectCard's own split exactly: the tile's primary click opens
  // CONTENT (there, /projects/:id/tickets; here, the work tab), and a
  // separate settings gear is the only way to reach settings. This card used
  // to route its primary click to the Connection/settings tab, identically
  // to the gear beside it — contradicting both its own body copy ("mirrored
  // live and writable from here") and its header comment's stated goal of
  // being "found the same way a project is found."
  it('opens the work tab — the content — on click, not settings', () => {
    mount(connection());

    fireEvent.click(getTile());

    expect(mockNavigate).toHaveBeenCalledWith('/my-jira');
  });

  // The settings button is a second, independently-clickable control inside
  // the tile — matching ProjectCard's own settings/archive icon-button
  // pattern exactly — and must not also trigger the tile's own outer click.
  it('the settings button opens the Connection tab, without double-firing', () => {
    mount(connection());

    fireEvent.click(screen.getByRole('button', { name: 'Jira connection settings' }));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
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
  it('renders the muted "Connect Jira" tile when the store says disconnected', () => {
    mount(connection({ connected: false, accountName: '', site: '' }));

    expect(screen.getByText('Connect Jira')).toBeInTheDocument();
    expect(screen.getByText('Companion project')).toBeInTheDocument();
    expect(screen.queryByText('Max Chen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-sync-indicator')).not.toBeInTheDocument();
  });

  // Before the store's first fetch resolves, useLoadedJiraConnection returns
  // `undefined` — this must render the same muted tile rather than nothing
  // at all or a broken read of a connection that doesn't exist yet.
  it('renders the same muted tile while the connection status is still loading', () => {
    mount(undefined);

    expect(screen.getByText('Connect Jira')).toBeInTheDocument();
  });

  it('opens the wizard via the passed-in handler instead of navigating', () => {
    const { onConnectClick } = mount(connection({ connected: false }));

    fireEvent.click(getTile());

    expect(onConnectClick).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // The settings button still renders in the not-connected tile (matching a
  // real ProjectCard's always-present settings icon) — clicking it opens the
  // same Connection tab rather than the wizard, since "review the (lack of a)
  // connection" and "start connecting" are different actions worth keeping
  // distinct even before anything is connected.
  it('the settings button still opens the Connection tab, not the wizard', () => {
    const { onConnectClick } = mount(connection({ connected: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Jira connection settings' }));

    expect(mockNavigate).toHaveBeenCalledWith('/my-jira?tab=connection');
    expect(onConnectClick).not.toHaveBeenCalled();
  });
});
