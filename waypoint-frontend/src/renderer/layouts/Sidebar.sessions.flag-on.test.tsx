import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  getWorkspace,
  listDraftTickets,
  listNotifications,
  listProjects,
  listReviewQueue,
} from '@/data/api';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import { useWaitingSessionsCount } from '@/lib/sessionsStore';
import { Sidebar } from './Sidebar';

// W3 (docs/design/w3-sessions-rail.md §1.1): "My sessions" sits directly
// under My work with an alert badge of runs waiting on the user. Behind
// SESSIONS_ENABLED at the component boundary, so a flag-off build never
// mounts the store hook (Sidebar.review-badge.test.tsx and the other
// flag-off Sidebar tests cover that the entry is absent there).
jest.mock('@/lib/featureFlags', () => ({
  MY_JIRA_ENABLED: false,
  SESSIONS_ENABLED: true,
}));
jest.mock('@/data/api', () => ({
  getWorkspace: jest.fn(),
  listProjects: jest.fn(),
  listReviewQueue: jest.fn(),
  listNotifications: jest.fn(),
  listDraftTickets: jest.fn(),
  detectLocalClaudeCode: jest.fn(),
}));
jest.mock('@/lib/useLocalSummary', () => ({
  useLocalSummary: () => ({
    repoCount: 0,
    claudeReady: false,
    sentence: 'Local · 0 repos · Claude not detected',
  }),
}));
jest.mock('@/lib/jiraStore', () => ({ useLoadedJiraConnection: jest.fn() }));
jest.mock('@/lib/sessionsStore', () => ({
  useWaitingSessionsCount: jest.fn(),
}));
jest.mock('@/components/domain/CreateProjectModal', () => ({
  CreateProjectModal: () => null,
}));
jest.mock('@/components/domain/AddProjectWizard', () => ({
  AddProjectWizard: () => null,
}));

function mount(onCollapse?: () => void) {
  jest
    .mocked(getWorkspace)
    .mockResolvedValue({ id: 'ws-1', name: 'Waypoint Labs' } as never);
  jest.mocked(listProjects).mockResolvedValue([]);
  jest.mocked(listReviewQueue).mockResolvedValue({
    proposals: [],
    counts: { proposed: 0, blocked: 0, recent: 0 },
    nextCursor: null,
  } as never);
  jest.mocked(listNotifications).mockResolvedValue([]);
  jest.mocked(listDraftTickets).mockResolvedValue([]);
  jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
  return render(
    <MemoryRouter>
      <Sidebar onCollapse={onCollapse} />
    </MemoryRouter>,
  );
}

beforeEach(() => jest.clearAllMocks());

describe('Sidebar with My sessions on', () => {
  it('lists My sessions right under My work, linking to /sessions, with the waiting count as an alert badge', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(3);
    mount();
    await act(async () => {});
    const link = screen.getByRole('link', { name: /My sessions/ });
    expect(link).toHaveAttribute('href', '/sessions');
    expect(link).toHaveTextContent('3');
    const links = screen.getAllByRole('link').map((l) => l.textContent);
    const myWork = links.findIndex((t) => t?.startsWith('My work'));
    expect(links[myWork + 1]).toMatch(/^My sessions/);
  });

  it('shows no badge when nothing is waiting', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);
    mount();
    await act(async () => {});
    expect(screen.getByRole('link', { name: /My sessions/ })).toHaveTextContent(
      /^My sessions$/,
    );
  });

  it('offers a way back to the rail only when the shell says there is one', async () => {
    const onCollapse = jest.fn();
    const { unmount } = mount(onCollapse);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    unmount();

    mount();
    await act(async () => {});
    expect(screen.queryByLabelText('Collapse sidebar')).not.toBeInTheDocument();
  });
});
