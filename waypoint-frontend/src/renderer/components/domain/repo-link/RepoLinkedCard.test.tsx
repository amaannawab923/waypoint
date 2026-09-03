import '@testing-library/jest-dom';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { updateProject } from '@/mock/api';
import { RepoLinkedCard } from './RepoLinkedCard';

jest.mock('@/mock/api', () => ({ updateProject: jest.fn() }));

const chooseFolder = jest.fn();
const describeRepo = jest.fn();

const FULL_DESCRIBE = {
  name: 'waypoint',
  displayPath: '~/code/waypoint',
  branch: 'main',
  lastCommitAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  trackedFileCount: 1284,
};

function mount(props: Partial<Parameters<typeof RepoLinkedCard>[0]> = {}) {
  return render(
    <RepoLinkedCard
      projectId="proj-1"
      projectName="Waypoint"
      repoPath="/Users/amaan/code/waypoint"
      onChanged={props.onChanged ?? jest.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  describeRepo.mockResolvedValue(FULL_DESCRIBE);
  (window as unknown as { electron: unknown }).electron = {
    repo: { chooseFolder, describe: describeRepo },
  };
});

afterEach(() => {
  cleanup();
});

describe('RepoLinkedCard', () => {
  it('shows the repo as a recognizable repo, not just a path string', async () => {
    mount();

    // Awaited on a describe-only value: the basename fallback renders before
    // the git detail lands, so waiting on the name alone would prove nothing.
    expect(await screen.findByText('~/code/waypoint')).toBeInTheDocument();
    expect(screen.getByText('waypoint')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('1,284')).toBeInTheDocument();
    expect(screen.getByText(/VERIFIED/)).toBeInTheDocument();
  });

  it('states the read-only scope Copilot actually has', async () => {
    mount();

    expect(await screen.findByText(/Read, Glob, Grep/)).toBeInTheDocument();
    expect(
      screen.getByText(/Never\s+edits, writes or runs anything/),
    ).toBeInTheDocument();
  });

  // A repo with no commits yet, a detached HEAD, or no `git` on PATH are all
  // real states — an absent chip is accurate, "unknown" would be noise.
  it('omits a chip entirely for a field the describe could not produce', async () => {
    describeRepo.mockResolvedValue({
      name: 'fresh',
      displayPath: '~/code/fresh',
      branch: null,
      lastCommitAt: null,
      trackedFileCount: null,
    });

    mount();

    expect(await screen.findByText('fresh')).toBeInTheDocument();
    expect(screen.queryByText('branch')).not.toBeInTheDocument();
    expect(screen.queryByText('last commit')).not.toBeInTheDocument();
    expect(screen.queryByText('tracked files')).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument();
  });

  it('falls back to the raw path and basename while describe has not landed', () => {
    describeRepo.mockReturnValue(new Promise(() => {}));

    mount();

    expect(screen.getByText('waypoint')).toBeInTheDocument();
    expect(screen.getByText('/Users/amaan/code/waypoint')).toBeInTheDocument();
  });

  // The gaps doc's specific complaint: "Change folder…" reopened a
  // context-free dialog that did not even start at the current link.
  it('opens the change dialog at the currently linked folder, titled for the project', async () => {
    chooseFolder.mockResolvedValue({ canceled: true });
    mount();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    });

    expect(chooseFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: '/Users/amaan/code/waypoint',
        title: 'Link Waypoint to its local checkout',
      }),
    );
  });

  describe('unlink', () => {
    it('does not offer Unlink at all unless the caller asks for it', async () => {
      mount();

      expect(
        await screen.findByRole('button', { name: /change folder/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Unlink' }),
      ).not.toBeInTheDocument();
    });

    it('confirms before writing anything — the first click is not destructive', async () => {
      mount({ showUnlink: true });

      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));

      expect(
        await screen.findByText('Unlink this repository?'),
      ).toBeInTheDocument();
      expect(updateProject).not.toHaveBeenCalled();
    });

    it('backs out cleanly on "Keep it"', async () => {
      mount({ showUnlink: true });
      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
      await screen.findByText('Unlink this repository?');

      fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

      await waitFor(() =>
        expect(
          screen.queryByText('Unlink this repository?'),
        ).not.toBeInTheDocument(),
      );
      expect(updateProject).not.toHaveBeenCalled();
    });

    it('unlinks immediately on confirm and offers an undo window', async () => {
      jest.mocked(updateProject).mockResolvedValue({} as never);
      const onChanged = jest.fn();
      mount({ showUnlink: true, onChanged });

      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
      await screen.findByText('Unlink this repository?');
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[0]);
      });

      expect(updateProject).toHaveBeenCalledWith(
        'proj-1',
        { repoPath: null },
        { silent: true },
      );
      // Deferred until the undo window resolves (undo or expiry) — an
      // immediate call here is what let the owning page's dispatcher swap
      // this card out for the unlinked picker before the Undo strip below
      // ever painted. See Codebase.test.tsx for the composed regression test.
      expect(onChanged).not.toHaveBeenCalled();
      expect(
        await screen.findByRole('button', { name: /Undo \(5s\)/ }),
      ).toBeInTheDocument();
    });

    it('restores the previous path on undo', async () => {
      jest.mocked(updateProject).mockResolvedValue({} as never);
      mount({ showUnlink: true });

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
    });
  });

  describe('compact (the in-chat variant)', () => {
    it('renders one dense row with no scope note and no unlink', async () => {
      mount({ compact: true, showUnlink: true });

      expect(
        await screen.findByText(/~\/code\/waypoint · main · updated/),
      ).toBeInTheDocument();
      expect(screen.getByText('waypoint')).toBeInTheDocument();
      expect(screen.queryByText(/Read, Glob, Grep/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Unlink' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /change folder/i }),
      ).not.toBeInTheDocument();
    });

    it('drops the missing pieces from the summary line rather than showing gaps', async () => {
      describeRepo.mockResolvedValue({
        name: 'fresh',
        displayPath: '~/code/fresh',
        branch: null,
        lastCommitAt: null,
        trackedFileCount: null,
      });

      mount({ compact: true });

      expect(await screen.findByText('~/code/fresh')).toBeInTheDocument();
    });
  });
});
