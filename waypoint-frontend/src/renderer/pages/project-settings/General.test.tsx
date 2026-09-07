import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { archiveProject } from '@/data/api';
import { useProject } from '@/layouts/ProjectLayout';
import type { Project } from '@/types/entities';
import General from './General';

jest.mock('@/data/api', () => ({
  archiveProject: jest.fn(),
  deleteProject: jest.fn(),
  updateProject: jest.fn(),
}));
jest.mock('@/layouts/ProjectLayout', () => ({ useProject: jest.fn() }));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const PROJECT: Project = {
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
    autoArchiveAfterDays: 30,
    autoCloseEnabled: false,
    autoCloseAfterDays: 30,
  },
  createdAt: new Date().toISOString(),
  archivedAt: null,
  memberIds: [],
  guestAccessEnabled: false,
  repoPath: null,
  primitiveCounts: { sprints: 0, workstreams: 0, views: 0, docs: 0, requests: 0, requestsPending: 0 },
  acceptsRequests: false,
};

function mount() {
  jest.mocked(useProject).mockReturnValue({
    project: PROJECT,
    reloadProject: jest.fn(),
  });
  return render(<General />);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// Found in review: a real project (Compass Web) was archived by a single,
// unconfirmed click on the settings page's own "Archive project" button —
// the same missing guard as the card button on ProjectsList, and the same
// fix. The panel's own description text above this button previously said
// "you'll still be able to access it from the projects page," which is
// false (archived projects are excluded from All Projects; only the
// separate Archive page lists them) — that's part of what sent the person
// who archived it looking in the wrong place first.
describe('project-settings General — archive confirmation', () => {
  it('asks for confirmation naming the project and the Archive page before archiving', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Compass Web/));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Archive/));
    await waitFor(() => expect(archiveProject).toHaveBeenCalledWith('proj-cw'));
    confirmSpy.mockRestore();
  });

  it('does not archive anything when the confirmation is declined', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(archiveProject).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // Pins the actual destination the description text now names, so a
  // future edit that quietly reintroduces "the projects page" (the
  // original, false claim) fails a test instead of shipping silently.
  it('correctly names the Archive page, not "the projects page", as where an archived project goes', () => {
    mount();

    expect(screen.queryByText(/access it from the projects page/i)).toBeNull();
    expect(screen.getByText(/Archive page/)).toBeInTheDocument();
  });
});
