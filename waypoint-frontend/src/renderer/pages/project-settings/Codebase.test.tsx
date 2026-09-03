import '@testing-library/jest-dom';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { listProjects, updateProject } from '@/mock/api';
import { ApiError } from '@/mock/httpClient';
import { useProject } from '@/layouts/ProjectLayout';
import type { Project } from '@/types/entities';
import Codebase from './Codebase';

jest.mock('@/mock/api', () => ({
  listProjects: jest.fn(),
  updateProject: jest.fn(),
}));
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
const checkPath = jest.fn();
const describeRepo = jest.fn();
let reloadProject: jest.Mock;
// Mutable so a test can let updateProject actually change the row, the way a
// real reload of the route project would — same convention as
// CopilotPanel.test.tsx's projectRow.
let currentProject: Project;

function mountWith(repoPath: string | null) {
  currentProject = { ...PROJECT, repoPath };
  let rerender: ReturnType<typeof render>['rerender'];
  // Wired to actually re-render with whatever `persistPatches()` has since
  // written to `currentProject` — a bare `jest.fn()` here would make
  // `reloadProject()` a no-op as far as the tree is concerned, which is
  // exactly the gap that let the real "Undo strip unmounts before it can
  // paint" bug (repoPath going null out from under CodebaseState) ship
  // without a failing test.
  reloadProject = jest.fn(() => rerender(<Codebase />));
  jest
    .mocked(useProject)
    .mockImplementation(() => ({ project: currentProject, reloadProject }));
  const utils = render(<Codebase />);
  rerender = utils.rerender;
  return utils;
}

/** Stands in for the backend write plus the route project's reload. */
function persistPatches() {
  jest.mocked(updateProject).mockImplementation(async (_id, patch) => {
    currentProject = { ...currentProject, ...patch } as Project;
    return currentProject;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(listProjects).mockResolvedValue([]);
  checkPath.mockResolvedValue({ exists: true });
  describeRepo.mockResolvedValue({
    name: 'waypoint',
    displayPath: '~/code/waypoint',
    branch: 'main',
    lastCommitAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    trackedFileCount: 42,
  });
  // The native dialog and the git calls behind describe are main-process OS
  // chrome — the only thing testable here is what this page does with
  // whatever comes back from them.
  (window as unknown as { electron: typeof window.electron }).electron = {
    repo: { chooseFolder, checkPath, describe: describeRepo },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  cleanup();
});

describe('project settings → Codebase', () => {
  it('offers a folder picker when nothing is linked yet', async () => {
    mountWith(null);

    expect(
      await screen.findByRole('button', { name: /browse/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Unlink' }),
    ).not.toBeInTheDocument();
    // Nothing to check when there is no path at all.
    expect(checkPath).not.toHaveBeenCalled();
  });

  it('shows the linked repo with change and unlink actions once linked', async () => {
    mountWith('/Users/amaan/code/waypoint');

    expect(await screen.findByText('~/code/waypoint')).toBeInTheDocument();
    expect(screen.getByText('waypoint')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /change folder/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
  });

  it('saves the picked path and reloads the project', async () => {
    chooseFolder.mockResolvedValue({
      canceled: false,
      path: '/Users/amaan/code/waypoint',
      looksLikeGitRepo: true,
    });
    jest.mocked(updateProject).mockResolvedValue({
      ...PROJECT,
      repoPath: '/Users/amaan/code/waypoint',
    });
    mountWith(null);

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /browse/i }));
    });

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith(
        'proj-1',
        { repoPath: '/Users/amaan/code/waypoint' },
        { silent: true },
      ),
    );
    await waitFor(() => expect(reloadProject).toHaveBeenCalled());
  });

  it('confirms the link once, in words, rather than silently swapping the button out', async () => {
    chooseFolder.mockResolvedValue({
      canceled: false,
      path: '/Users/amaan/code/waypoint',
      looksLikeGitRepo: true,
    });
    persistPatches();
    mountWith(null);
    const browse = await screen.findByRole('button', { name: /browse/i });

    await act(async () => {
      fireEvent.click(browse);
    });

    expect(
      await screen.findByText(/Copilot can now read this project's code/),
    ).toBeInTheDocument();
  });

  // Regression test: the success banner was gated on `status.kind !==
  // 'unlinked'`, which is also true for 'stale' — so a repo that comes back
  // already-broken on its very first check (moved mid-pick, a bad mount, a
  // flaky check) rendered "Linked — Copilot can now read this project's
  // code" directly above "no longer exists … without code access".
  it('does not show the success banner if the just-linked repo comes back stale on its first check', async () => {
    chooseFolder.mockResolvedValue({
      canceled: false,
      path: '/Users/amaan/code/waypoint',
      looksLikeGitRepo: true,
    });
    checkPath.mockResolvedValueOnce({ exists: false });
    persistPatches();
    mountWith(null);
    const browse = await screen.findByRole('button', { name: /browse/i });

    await act(async () => {
      fireEvent.click(browse);
    });

    expect(
      await screen.findByText('The linked folder no longer exists'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Copilot can now read this project's code/),
    ).not.toBeInTheDocument();
  });

  // The suggestions strip is the whole point of G2: a second repo on a
  // machine that already has one should never need a file dialog.
  it('links a suggested folder in one click, without opening the dialog', async () => {
    jest.mocked(listProjects).mockResolvedValue([
      {
        ...PROJECT,
        id: 'proj-2',
        name: 'Atlas',
        repoPath: '/Users/amaan/code/atlas',
      },
    ]);
    persistPatches();
    mountWith(null);
    // Resolved outside act(): a findBy* poll cannot settle inside one.
    const suggestion = (await screen.findByText('atlas')).closest('button')!;

    await act(async () => {
      fireEvent.click(suggestion);
    });

    expect(updateProject).toHaveBeenCalledWith(
      'proj-1',
      { repoPath: '/Users/amaan/code/atlas' },
      { silent: true },
    );
    expect(chooseFolder).not.toHaveBeenCalled();
  });

  it('does nothing at all when the dialog is canceled', async () => {
    chooseFolder.mockResolvedValue({ canceled: true });
    mountWith(null);

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /browse/i }));
    });

    await waitFor(() => expect(chooseFolder).toHaveBeenCalled());
    expect(updateProject).not.toHaveBeenCalled();
    expect(reloadProject).not.toHaveBeenCalled();
  });

  // The backend is still the single source of truth for "is this a real git
  // checkout" (projects.service.ts's validateRepoPath) — its message now sits
  // under a disclosure instead of leading, but it must still reach the user
  // and must not escape past the component.
  it('leads a validation failure with human copy and keeps the raw message available', async () => {
    chooseFolder.mockResolvedValue({
      canceled: false,
      path: '/Users/amaan/not-a-repo',
      looksLikeGitRepo: false,
    });
    jest
      .mocked(updateProject)
      .mockRejectedValue(
        new ApiError(
          'repoPath is not a git repository: /Users/amaan/not-a-repo',
          'repo_path_not_git_repo',
          '/Users/amaan/not-a-repo',
        ),
      );
    mountWith(null);

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /browse/i }));
    });

    expect(
      await screen.findByText("That folder isn't a git repository"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'repoPath is not a git repository: /Users/amaan/not-a-repo',
      ),
    ).toBeInTheDocument();
    expect(reloadProject).not.toHaveBeenCalled();
    // Still usable afterward — a failed pick must not leave the page stuck in
    // its saving state.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /browse/i }),
      ).not.toBeDisabled(),
    );
  });

  // Regression test: RepoLinkedCard only ever destructured `saving`/`browse`
  // from useRepoLink, dropping `error` on the floor — a rejected "Change
  // folder…" pick failed the backend PATCH with zero feedback anywhere on
  // screen (no inline error, no toast, since useRepoLink always calls
  // updateProject with `{ silent: true }`).
  it('shows an inline error when Change folder… picks something invalid, instead of failing silently', async () => {
    chooseFolder.mockResolvedValue({
      canceled: false,
      path: '/Users/amaan/not-a-repo',
      looksLikeGitRepo: false,
    });
    jest
      .mocked(updateProject)
      .mockRejectedValue(
        new ApiError(
          'repoPath is not a git repository: /Users/amaan/not-a-repo',
          'repo_path_not_git_repo',
          '/Users/amaan/not-a-repo',
        ),
      );
    mountWith('/Users/amaan/code/waypoint');
    await screen.findByRole('button', { name: 'Unlink' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    });

    expect(
      await screen.findByText("That folder isn't a git repository"),
    ).toBeInTheDocument();
    expect(reloadProject).not.toHaveBeenCalled();
    // The card it failed on is still the linked one — not silently swapped
    // for anything else.
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
  });

  describe('unlink', () => {
    it('asks before writing anything — one click is no longer destructive', async () => {
      mountWith('/Users/amaan/code/waypoint');
      await screen.findByRole('button', { name: 'Unlink' });

      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));

      expect(
        await screen.findByText('Unlink this repository?'),
      ).toBeInTheDocument();
      expect(updateProject).not.toHaveBeenCalled();
    });

    it('patches repoPath to null on confirm, without opening the picker', async () => {
      persistPatches();
      mountWith('/Users/amaan/code/waypoint');
      await screen.findByRole('button', { name: 'Unlink' });

      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
      await screen.findByText('Unlink this repository?');
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[0]);
      });

      await waitFor(() =>
        expect(updateProject).toHaveBeenCalledWith(
          'proj-1',
          { repoPath: null },
          { silent: true },
        ),
      );
      expect(chooseFolder).not.toHaveBeenCalled();
      // Regression guard: the route project must not reload yet. It used to
      // reload here (via an immediate onChanged), which flips project.repoPath
      // to null and has CodebaseState swap RepoLinkedCard for the unlinked
      // picker — unmounting the Undo strip before a user could ever click it.
      // reloadProject is now deferred until Undo is clicked (see the next
      // test) or the window naturally expires (useRepoLink.test.tsx).
      expect(reloadProject).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /Undo/ })).toBeInTheDocument();
    });

    it('restores the path on undo, as a second write rather than a deferred unlink', async () => {
      persistPatches();
      mountWith('/Users/amaan/code/waypoint');
      await screen.findByRole('button', { name: 'Unlink' });

      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
      await screen.findByText('Unlink this repository?');
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[0]);
      });
      await screen.findByRole('button', { name: /Undo/ });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
      });

      expect(jest.mocked(updateProject).mock.calls[1]).toEqual([
        'proj-1',
        { repoPath: '/Users/amaan/code/waypoint' },
        { silent: true },
      ]);
      // Undo is what finally reloads the route project — and once it does,
      // the page lands back on the ordinary linked card, not the picker.
      await waitFor(() => expect(reloadProject).toHaveBeenCalled());
      expect(
        await screen.findByRole('button', { name: /change folder/i }),
      ).toBeInTheDocument();
    });
  });

  describe('a link whose folder has since moved', () => {
    it('says so instead of displaying the dead path as healthy', async () => {
      checkPath.mockResolvedValue({ exists: false });

      mountWith('/Users/amaan/code/gone');

      expect(
        await screen.findByText('The linked folder no longer exists'),
      ).toBeInTheDocument();
      expect(screen.getByText(/without code access/)).toBeInTheDocument();
      expect(screen.queryByText(/VERIFIED/)).not.toBeInTheDocument();
    });

    it("opens Relocate at the dead path's parent, since the folder itself is gone", async () => {
      checkPath.mockResolvedValue({ exists: false });
      chooseFolder.mockResolvedValue({ canceled: true });
      mountWith('/Users/amaan/code/gone');
      await screen.findByText('The linked folder no longer exists');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /relocate/i }));
      });

      expect(chooseFolder).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: '/Users/amaan/code' }),
      );
    });

    // Regression test: this card used to mount two independent useRepoLink
    // instances — its own Relocate… plus the suggestions strip's own
    // Browse… — both opening the same kind of dialog, with two
    // independently-styled error surfaces depending on which was clicked.
    it('offers exactly one way to open the picker, not a second Browse… next to Relocate…', async () => {
      checkPath.mockResolvedValue({ exists: false });
      mountWith('/Users/amaan/code/gone');
      await screen.findByText('The linked folder no longer exists');

      expect(
        screen.getByRole('button', { name: /relocate/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /browse/i }),
      ).not.toBeInTheDocument();
    });

    // Regression test: a successful Relocate used to call the plain
    // onChanged callback (the same one Unlink uses), which never sets
    // justLinked — so recovering from a stale link, unlike an initial link,
    // never confirmed anything happened.
    it('shows the success banner once Relocate actually lands a working path', async () => {
      checkPath
        .mockResolvedValueOnce({ exists: false })
        .mockResolvedValue({ exists: true });
      chooseFolder.mockResolvedValue({
        canceled: false,
        path: '/Users/amaan/code/waypoint-moved',
        looksLikeGitRepo: true,
      });
      persistPatches();
      mountWith('/Users/amaan/code/gone');
      await screen.findByText('The linked folder no longer exists');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /relocate/i }));
      });

      expect(
        await screen.findByText(/Copilot can now read this project's code/),
      ).toBeInTheDocument();
    });

    // Same bug as Change folder…, on the other component: RepoLinkStaleCard
    // also dropped `error` from useRepoLink, so a bad Relocate… pick had
    // nowhere to surface — arguably worse here, since Relocate is reached
    // for specifically to repair an already-broken link.
    it('shows an inline error when Relocate… picks something invalid, instead of failing silently', async () => {
      checkPath.mockResolvedValue({ exists: false });
      chooseFolder.mockResolvedValue({
        canceled: false,
        path: '/Users/amaan/not-a-repo',
        looksLikeGitRepo: false,
      });
      jest
        .mocked(updateProject)
        .mockRejectedValue(
          new ApiError(
            'repoPath is not a git repository: /Users/amaan/not-a-repo',
            'repo_path_not_git_repo',
            '/Users/amaan/not-a-repo',
          ),
        );
      mountWith('/Users/amaan/code/gone');
      await screen.findByText('The linked folder no longer exists');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /relocate/i }));
      });

      expect(
        await screen.findByText("That folder isn't a git repository"),
      ).toBeInTheDocument();
      expect(reloadProject).not.toHaveBeenCalled();
      // Still the stale card underneath the error, not silently swapped out.
      expect(
        screen.getByText('The linked folder no longer exists'),
      ).toBeInTheDocument();
    });

    it('unlinks a known-broken link without a second confirmation step', async () => {
      checkPath.mockResolvedValue({ exists: false });
      jest
        .mocked(updateProject)
        .mockResolvedValue({ ...PROJECT, repoPath: null });
      mountWith('/Users/amaan/code/gone');
      await screen.findByText('The linked folder no longer exists');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
      });

      await waitFor(() =>
        expect(updateProject).toHaveBeenCalledWith(
          'proj-1',
          { repoPath: null },
          { silent: true },
        ),
      );
      expect(
        await screen.findByRole('button', { name: /Undo/ }),
      ).toBeInTheDocument();
    });
  });
});
