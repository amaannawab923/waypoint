import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  listProjects,
  listMembers,
  listAllTickets,
  listSprints,
  archiveProject,
} from '@/data/api';
import type { Project } from '@/types/entities';
import ProjectsList from './ProjectsList';

// MY_JIRA_ENABLED off — this file is about the archive-confirmation guard,
// which has nothing to do with Jira; ProjectsList.flag-on.test.tsx already
// covers the flag-specific behavior.
jest.mock('@/lib/featureFlags', () => ({ MY_JIRA_ENABLED: false }));
jest.mock('@/data/api', () => ({
  listProjects: jest.fn(),
  listMembers: jest.fn(),
  listAllTickets: jest.fn(),
  listSprints: jest.fn(),
  archiveProject: jest.fn(),
}));
jest.mock('@/components/domain/AddProjectWizard', () => ({
  AddProjectWizard: () => null,
}));
jest.mock('@/components/domain/CreateProjectModal', () => ({
  CreateProjectModal: () => null,
}));

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-cw',
    workspaceId: 'ws-1',
    name: 'Compass Web',
    identifier: 'CW',
    description: '',
    icon: '🧭',
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
  jest.mocked(listProjects).mockResolvedValue([project()]);
  jest.mocked(listMembers).mockResolvedValue([]);
  jest.mocked(listAllTickets).mockResolvedValue([]);
  jest.mocked(listSprints).mockResolvedValue([]);
});

// Found in review: a real project (Compass Web) was archived by a single,
// unconfirmed click on this exact button, then had to be restored by hand
// from the database. This pins the fix: the click must not reach
// archiveProject at all unless the user confirms, and the confirm text must
// actually say where the project goes, not just that it's reversible — the
// second half of the same incident was not being able to find it afterward.
describe('ProjectsList — archive confirmation', () => {
  it('asks for confirmation naming the project and the Archive page before archiving', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    await screen.findByText('Compass Web');

    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Compass Web/),
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Archive/),
    );
    await waitFor(() => expect(archiveProject).toHaveBeenCalledWith('proj-cw'));
    confirmSpy.mockRestore();
  });

  it('does not archive anything when the confirmation is declined', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    await screen.findByText('Compass Web');

    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(archiveProject).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
