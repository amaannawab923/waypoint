import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { updateProject } from '@/mock/api';
import { useProject } from '@/layouts/ProjectLayout';
import type { Project } from '@/types/entities';
import Codebase from './Codebase';

jest.mock('@/mock/api', () => ({ updateProject: jest.fn() }));
jest.mock('@/layouts/ProjectLayout', () => ({ useProject: jest.fn() }));

const PROJECT: Project = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Launch',
  identifier: 'LAUNCH',
  description: '',
  icon: '📦',
  coverGradient: ['#c2542a', '#3a2314'],
  network: 'public',
  leadId: null,
  defaultAssigneeId: null,
  timezone: 'UTC',
  features: {
    cycles: true,
    modules: true,
    views: true,
    pages: true,
    intake: true,
  },
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
};

const chooseFolder = jest.fn();
let reloadProject: jest.Mock;

function mountWith(repoPath: string | null) {
  reloadProject = jest.fn();
  jest.mocked(useProject).mockReturnValue({
    project: { ...PROJECT, repoPath },
    reloadProject,
  });
  return render(<Codebase />);
}

beforeEach(() => {
  jest.clearAllMocks();
  // The native dialog is main-process OS chrome — the only thing testable
  // here is what this page does with whatever path comes back from it.
  (window as unknown as { electron: typeof window.electron }).electron = {
    repo: { chooseFolder },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  cleanup();
});

describe('project settings → Codebase', () => {
  it('offers a folder picker when nothing is linked yet', () => {
    mountWith(null);

    expect(screen.getByRole('button', { name: /choose folder/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
  });

  it('shows the linked path with change and unlink actions once linked', () => {
    mountWith('/Users/amaan/code/waypoint');

    expect(screen.getByText('/Users/amaan/code/waypoint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change folder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
  });

  it('saves the picked path and reloads the project', async () => {
    chooseFolder.mockResolvedValue({ canceled: false, path: '/Users/amaan/code/waypoint' });
    jest.mocked(updateProject).mockResolvedValue({
      ...PROJECT,
      repoPath: '/Users/amaan/code/waypoint',
    });
    mountWith(null);

    fireEvent.click(screen.getByRole('button', { name: /choose folder/i }));

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith('proj-1', {
        repoPath: '/Users/amaan/code/waypoint',
      }),
    );
    await waitFor(() => expect(reloadProject).toHaveBeenCalled());
  });

  it('does nothing at all when the dialog is canceled', async () => {
    chooseFolder.mockResolvedValue({ canceled: true });
    mountWith(null);

    fireEvent.click(screen.getByRole('button', { name: /choose folder/i }));

    await waitFor(() => expect(chooseFolder).toHaveBeenCalled());
    expect(updateProject).not.toHaveBeenCalled();
    expect(reloadProject).not.toHaveBeenCalled();
  });

  // The backend is the single source of truth for "is this a real git
  // checkout" (projects.service.ts's validateRepoPath), so its 400 message
  // has to reach the user here — and must not escape past the component.
  it('renders a backend validation failure inline instead of throwing', async () => {
    chooseFolder.mockResolvedValue({ canceled: false, path: '/Users/amaan/not-a-repo' });
    jest
      .mocked(updateProject)
      .mockRejectedValue(new Error('repoPath is not a git repository: /Users/amaan/not-a-repo'));
    mountWith(null);

    fireEvent.click(screen.getByRole('button', { name: /choose folder/i }));

    expect(
      await screen.findByText('repoPath is not a git repository: /Users/amaan/not-a-repo'),
    ).toBeInTheDocument();
    expect(reloadProject).not.toHaveBeenCalled();
    // Still usable afterward — a failed pick must not leave the page stuck
    // in its saving state.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /choose folder/i })).not.toBeDisabled(),
    );
  });

  it('unlinks by patching repoPath to null, without opening the picker', async () => {
    jest.mocked(updateProject).mockResolvedValue({ ...PROJECT, repoPath: null });
    mountWith('/Users/amaan/code/waypoint');

    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith('proj-1', { repoPath: null }),
    );
    expect(chooseFolder).not.toHaveBeenCalled();
    await waitFor(() => expect(reloadProject).toHaveBeenCalled());
  });
});
