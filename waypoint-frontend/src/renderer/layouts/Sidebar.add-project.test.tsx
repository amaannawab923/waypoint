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

// MY_JIRA_ENABLED is unmocked here — under Jest, WAYPOINT_FEATURE_MY_JIRA is
// unset, so featureFlags.ts's own `=== 'true'` check evaluates to false,
// which is exactly the default-off case this file covers: the wizard
// component must not even be in the tree, and the "+" button's behavior must
// be byte-for-byte what it always was.
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

describe('Sidebar "Add project" — MY_JIRA_ENABLED off (default)', () => {
  it('opens CreateProjectModal directly; AddProjectWizard never mounts', async () => {
    mount();
    await screen.findByText('Waypoint Labs');

    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));

    expect(screen.getByTestId('create-project-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('add-project-wizard')).not.toBeInTheDocument();
  });
});
