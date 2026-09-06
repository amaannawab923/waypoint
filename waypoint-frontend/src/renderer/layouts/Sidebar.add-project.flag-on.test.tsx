import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  detectLocalClaudeCode,
  getProposalCounts,
  getWorkspace,
  listDraftTickets,
  listNotifications,
  listProjects,
} from '@/data/api';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import { Sidebar } from './Sidebar';

// A separate file (rather than jest.resetModules() inside one test) for the
// same reason AppShell.flag-disabled.test.tsx gives: a dynamically
// re-required module would load a second copy of `react`, breaking hooks
// against this file's own JSX. A statically mocked flag value for this whole
// file sidesteps that.
jest.mock('@/lib/featureFlags', () => ({
  MY_JIRA_ENABLED: true,
}));
jest.mock('@/data/api', () => ({
  getWorkspace: jest.fn(),
  listProjects: jest.fn(),
  getProposalCounts: jest.fn(),
  listNotifications: jest.fn(),
  listDraftTickets: jest.fn(),
  detectLocalClaudeCode: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({ useLoadedJiraConnection: jest.fn() }));
jest.mock('@/components/domain/CreateProjectModal', () => ({
  CreateProjectModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-project-modal" /> : null,
}));
jest.mock('@/components/domain/AddProjectWizard', () => ({
  AddProjectWizard: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-project-wizard" /> : null,
}));

function mount() {
  jest
    .mocked(getWorkspace)
    .mockResolvedValue({ id: 'ws-1', name: 'Waypoint Labs' } as never);
  jest.mocked(listProjects).mockResolvedValue([]);
  jest.mocked(getProposalCounts).mockResolvedValue({ proposed: 0 } as never);
  jest.mocked(listNotifications).mockResolvedValue([]);
  jest.mocked(listDraftTickets).mockResolvedValue([]);
  jest
    .mocked(detectLocalClaudeCode)
    .mockResolvedValue({ state: 'absent' } as never);
  jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Sidebar "Add project" — MY_JIRA_ENABLED on', () => {
  it('opens AddProjectWizard instead of CreateProjectModal', async () => {
    mount();
    await screen.findByText('Waypoint Labs');

    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));

    expect(screen.getByTestId('add-project-wizard')).toBeInTheDocument();
    expect(
      screen.queryByTestId('create-project-modal'),
    ).not.toBeInTheDocument();
  });
});
