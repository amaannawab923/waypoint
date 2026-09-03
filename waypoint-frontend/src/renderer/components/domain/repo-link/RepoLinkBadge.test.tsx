import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Project } from '@/types/entities';
import { RepoLinkBadge } from './RepoLinkBadge';

jest.mock('@/mock/api', () => ({ updateProject: jest.fn() }));

const checkPath = jest.fn();
const describeRepo = jest.fn();

const PROJECT: Project = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Waypoint',
  identifier: 'WPT',
  description: '',
  icon: '📦',
  coverGradient: ['#000', '#111'],
  network: 'public',
  leadId: null,
  defaultAssigneeId: null,
  timezone: 'UTC',
  features: { cycles: true, modules: true, views: true, pages: true, intake: true },
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

function mount(repoPath: string | null) {
  return render(
    <MemoryRouter initialEntries={['/projects/proj-1/issues']}>
      <Routes>
        <Route
          path="/projects/:projectId/issues"
          element={<RepoLinkBadge project={{ ...PROJECT, repoPath }} onChanged={jest.fn()} />}
        />
        <Route
          path="/projects/:projectId/settings/codebase"
          element={<div>Codebase settings page</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  describeRepo.mockResolvedValue({
    name: 'waypoint',
    displayPath: '~/code/waypoint',
    branch: 'main',
    lastCommitAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    trackedFileCount: 12,
  });
  (window as unknown as { electron: unknown }).electron = {
    repo: { checkPath, describe: describeRepo },
  };
});

afterEach(() => {
  cleanup();
});

describe('RepoLinkBadge', () => {
  it('states the project is ungrounded when nothing is linked', () => {
    mount(null);

    expect(screen.getByRole('button', { name: /code not linked/i })).toBeInTheDocument();
    expect(checkPath).not.toHaveBeenCalled();
  });

  it('takes an unlinked project straight to the page that fixes it', () => {
    mount(null);

    fireEvent.click(screen.getByRole('button', { name: /code not linked/i }));

    expect(screen.getByText('Codebase settings page')).toBeInTheDocument();
  });

  it('names the linked repo once the path is confirmed to resolve', async () => {
    checkPath.mockResolvedValue({ exists: true });

    mount('/Users/a/code/waypoint');

    expect(await screen.findByRole('button', { name: /waypoint/ })).toBeInTheDocument();
  });

  // The stale case is the one the shipped feature had no signal for at all:
  // repoPath stayed non-null, so nothing anywhere said the answers had
  // silently stopped being grounded.
  it('warns when the stored path no longer resolves', async () => {
    checkPath.mockResolvedValue({ exists: false });

    mount('/Users/a/code/gone');

    expect(
      await screen.findByRole('button', { name: /repo folder missing/i }),
    ).toBeInTheDocument();
  });

  it('routes a stale badge to the settings page too', async () => {
    checkPath.mockResolvedValue({ exists: false });
    mount('/Users/a/code/gone');
    const badge = await screen.findByRole('button', { name: /repo folder missing/i });

    fireEvent.click(badge);

    expect(screen.getByText('Codebase settings page')).toBeInTheDocument();
  });

  // Not "linked" while unknown: the unlinked affordance is the honest thing
  // to show before the check resolves, and it flickers less than a third state.
  it('shows the unlinked affordance while the check is still in flight', () => {
    checkPath.mockReturnValue(new Promise(() => {}));

    mount('/Users/a/code/waypoint');

    expect(screen.getByRole('button', { name: /code not linked/i })).toBeInTheDocument();
  });

  it('costs no git subprocess until someone actually opens the popover', async () => {
    checkPath.mockResolvedValue({ exists: true });
    mount('/Users/a/code/waypoint');
    await screen.findByRole('button', { name: /waypoint/ });

    expect(describeRepo).not.toHaveBeenCalled();
  });

  it('reveals the path, branch and actions on hover', async () => {
    checkPath.mockResolvedValue({ exists: true });
    mount('/Users/a/code/waypoint');
    const badge = await screen.findByRole('button', { name: /waypoint/ });

    fireEvent.mouseEnter(badge.parentElement!);

    await waitFor(() => expect(describeRepo).toHaveBeenCalledWith('/Users/a/code/waypoint'));
    expect(await screen.findByText('~/code/waypoint')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change folder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open in settings/i })).toBeInTheDocument();
  });
});
