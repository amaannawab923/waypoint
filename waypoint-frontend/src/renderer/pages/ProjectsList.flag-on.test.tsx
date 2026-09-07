import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  listProjects,
  listMembers,
  listAllTickets,
  listSprints,
} from '@/data/api';
import type { Project } from '@/types/entities';
import ProjectsList from './ProjectsList';

// Separate file for the same reason Sidebar.add-project.flag-on.test.tsx is:
// jest.mock('@/lib/featureFlags', ...) needs a static per-file value, and a
// dynamically re-required module would load a second copy of React.
jest.mock('@/lib/featureFlags', () => ({ MY_JIRA_ENABLED: true }));
jest.mock('@/data/api', () => ({
  listProjects: jest.fn(),
  listMembers: jest.fn(),
  listAllTickets: jest.fn(),
  listSprints: jest.fn(),
  archiveProject: jest.fn(),
}));
// A lightweight stand-in — the real card pulls in MyJiraPage's whole tree
// (LiveSyncIndicator, jiraApi, useMyJiraQueue…) purely to render one already-
// exported component, none of which this file needs. What matters here is
// only that the card renders somewhere in the grid, which every test below
// asserts on the stub's own testid.
jest.mock('@/components/domain/JiraConnectionCard', () => ({
  JiraConnectionCard: () => <div data-testid="jira-connection-card" />,
}));
jest.mock('@/components/domain/AddProjectWizard', () => ({
  AddProjectWizard: () => null,
}));
jest.mock('@/components/domain/CreateProjectModal', () => ({
  CreateProjectModal: () => null,
}));

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    workspaceId: 'ws-1',
    name: 'Checkout',
    identifier: 'CHK',
    description: '',
    icon: '🛒',
    coverGradient: ['#111', '#222'],
    visibility: 'public',
    leadId: null,
    defaultAssigneeId: null,
    timezone: 'UTC',
    estimate: null,
    automations: {
      autoArchiveEnabled: false,
      autoArchiveAfterDays: 0,
      autoCloseEnabled: false,
      autoCloseAfterDays: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    memberIds: [],
    guestAccessEnabled: false,
    repoPath: null,
    primitiveCounts: {
      sprints: 0,
      workstreams: 0,
      views: 0,
      docs: 0,
      requests: 0,
      requestsPending: 0,
    },
    acceptsRequests: false,
    ...overrides,
  };
}

function mount() {
  return render(
    <MemoryRouter>
      <ProjectsList />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(listMembers).mockResolvedValue([]);
  jest.mocked(listAllTickets).mockResolvedValue([]);
  jest.mocked(listSprints).mockResolvedValue([]);
});

describe('ProjectsList — MY_JIRA_ENABLED on', () => {
  // The bug this pins: an earlier version suppressed the "no projects match
  // this filter" message unconditionally whenever the flag was on, so
  // filtering to a bucket with zero matches showed only the persistent Jira
  // tile with no feedback that the filter itself was what emptied the grid.
  it('still shows "no projects match this filter" when real projects exist but the filter excludes all of them', async () => {
    jest
      .mocked(listProjects)
      .mockResolvedValue([project({ id: 'proj-1', visibility: 'public' })]);
    mount();
    await screen.findByText('Checkout');

    // The button's own text content is lowercase ('private'); the visual
    // capitalization is CSS-only (`capitalize` class) and doesn't change the
    // accessible name testing-library queries against.
    fireEvent.click(screen.getByRole('button', { name: 'private' }));

    expect(
      await screen.findByText('No projects match this filter'),
    ).toBeInTheDocument();
    // The Jira tile still renders alongside it — it isn't a Project row, so
    // the filter mismatch and its own presence are independent facts.
    expect(screen.getByTestId('jira-connection-card')).toBeInTheDocument();
  });

  // The case the suppression was actually meant for: no projects exist at
  // all, so there is nothing a filter could be blamed for hiding. The grid
  // still renders (with just the Jira tile), and no "no results" message is
  // owed — this must keep working exactly as it did before the fix above.
  it('does not show the filter-mismatch message when there are simply no projects yet', async () => {
    jest.mocked(listProjects).mockResolvedValue([]);
    mount();

    expect(await screen.findByTestId('jira-connection-card')).toBeInTheDocument();
    expect(
      screen.queryByText('No projects match this filter'),
    ).not.toBeInTheDocument();
  });
});
