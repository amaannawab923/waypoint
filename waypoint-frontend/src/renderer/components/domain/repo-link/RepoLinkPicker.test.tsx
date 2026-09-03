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
import type { Project } from '@/types/entities';
import { RepoLinkPicker } from './RepoLinkPicker';

jest.mock('@/mock/api', () => ({
  listProjects: jest.fn(),
  updateProject: jest.fn(),
}));

const chooseFolder = jest.fn();

function project(
  over: Partial<Project> & { id: string; name: string },
): Project {
  return {
    workspaceId: 'ws-1',
    identifier: 'X',
    description: '',
    icon: '📦',
    coverGradient: ['#000', '#111'],
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
    ...over,
  } as Project;
}

function mount(props: Partial<Parameters<typeof RepoLinkPicker>[0]> = {}) {
  return render(
    <RepoLinkPicker
      projectId="proj-1"
      projectName="Waypoint"
      projectIdentifier="WPT"
      onLinked={props.onLinked ?? jest.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(listProjects).mockResolvedValue([]);
  (window as unknown as { electron: unknown }).electron = {
    repo: { chooseFolder },
  };
});

afterEach(() => {
  cleanup();
});

describe('RepoLinkPicker', () => {
  it('offers Browse as the only door when nothing else has ever been linked', async () => {
    mount();

    expect(
      await screen.findByRole('button', { name: /browse/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Suggestions')).not.toBeInTheDocument();
  });

  it("leads with other projects' repo roots instead of a cold dialog", async () => {
    jest
      .mocked(listProjects)
      .mockResolvedValue([
        project({ id: 'p2', name: 'Old', repoPath: '/Users/a/code/waypoint' }),
      ]);

    mount();

    expect(await screen.findByText('Suggestions')).toBeInTheDocument();
    expect(screen.getByText('waypoint')).toBeInTheDocument();
    expect(screen.getByText('name matches project')).toBeInTheDocument();
  });

  it('links a suggestion in one click, never opening the OS dialog', async () => {
    jest
      .mocked(listProjects)
      .mockResolvedValue([
        project({ id: 'p2', name: 'Old', repoPath: '/Users/a/code/waypoint' }),
      ]);
    jest.mocked(updateProject).mockResolvedValue({} as never);
    const onLinked = jest.fn();
    mount({ onLinked });
    await screen.findByText('waypoint');

    await act(async () => {
      fireEvent.click(screen.getByText('waypoint').closest('button')!);
    });

    expect(updateProject).toHaveBeenCalledWith(
      'proj-1',
      { repoPath: '/Users/a/code/waypoint' },
      { silent: true },
    );
    expect(chooseFolder).not.toHaveBeenCalled();
    expect(onLinked).toHaveBeenCalledWith('/Users/a/code/waypoint');
  });

  it('names the project on the dialog it opens', async () => {
    chooseFolder.mockResolvedValue({ canceled: true });
    mount();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /browse/i }));
    });

    expect(chooseFolder).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Link Waypoint to its local checkout' }),
    );
  });

  it('opens Relocate at the caller-supplied parent rather than the dead path', async () => {
    chooseFolder.mockResolvedValue({ canceled: true });
    mount({ browseDefaultPath: '/Users/a/code', browseLabel: 'Relocate…' });

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /relocate/i }));
    });

    expect(chooseFolder).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: '/Users/a/code' }),
    );
  });

  describe('a rejected pick', () => {
    async function failWith(err: unknown) {
      chooseFolder.mockResolvedValue({
        canceled: false,
        path: '/Users/a/code/waypoint/src',
        looksLikeGitRepo: false,
      });
      jest.mocked(updateProject).mockRejectedValue(err);
      mount();
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /browse/i }));
      });
    }

    it('leads with human, actionable copy rather than the internal field name', async () => {
      await failWith(
        new ApiError(
          'repoPath is not a git repository: /Users/a/code/waypoint/src',
          'repo_path_not_git_repo',
          '/Users/a/code/waypoint/src',
        ),
      );

      expect(
        await screen.findByText("That folder isn't a git repository"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Pick the folder that contains .git/),
      ).toBeInTheDocument();
    });

    // The backend message stays the source of truth — it just stops leading.
    it('keeps the raw backend message under a Technical details disclosure', async () => {
      await failWith(
        new ApiError(
          'repoPath is not a git repository: /Users/a/code/waypoint/src',
          'repo_path_not_git_repo',
          '/Users/a/code/waypoint/src',
        ),
      );

      await screen.findByText("That folder isn't a git repository");
      expect(screen.getByText('Technical details')).toBeInTheDocument();
      expect(
        screen.getByText(
          'repoPath is not a git repository: /Users/a/code/waypoint/src',
        ),
      ).toBeInTheDocument();
    });

    it('falls back to the raw message when the failure carries no code', async () => {
      await failWith(new Error('Network error: /projects/proj-1'));

      expect(
        await screen.findByText('Something went wrong'),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText('Network error: /projects/proj-1').length,
      ).toBeGreaterThan(0);
    });

    it('stays usable afterwards, with a way straight back to the dialog', async () => {
      await failWith(new Error('nope'));
      await screen.findByText('Something went wrong');

      expect(
        screen.getByRole('button', { name: /choose a different folder/i }),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /browse/i }),
        ).not.toBeDisabled(),
      );
    });

    it('dismisses the error on request', async () => {
      await failWith(new Error('nope'));
      await screen.findByText('Something went wrong');

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

      await waitFor(() =>
        expect(
          screen.queryByText('Something went wrong'),
        ).not.toBeInTheDocument(),
      );
    });
  });

  it('renders a denser suggestion row and drops the section label when compact', async () => {
    jest
      .mocked(listProjects)
      .mockResolvedValue([
        project({ id: 'p2', name: 'Old', repoPath: '/Users/a/code/waypoint' }),
      ]);

    mount({ compact: true });

    expect(await screen.findByText('waypoint')).toBeInTheDocument();
    expect(screen.queryByText('Suggestions')).not.toBeInTheDocument();
    expect(screen.queryByText('name matches project')).not.toBeInTheDocument();
  });

  // hideBrowse is for a caller (RepoLinkStaleCard) that already offers its
  // own, differently-labeled dialog trigger — without this, that caller
  // ends up with two buttons opening the same picker.
  describe('hideBrowse', () => {
    it('renders suggestions with no Browse… button or hint text', async () => {
      jest
        .mocked(listProjects)
        .mockResolvedValue([
          project({
            id: 'p2',
            name: 'Old',
            repoPath: '/Users/a/code/waypoint',
          }),
        ]);

      mount({ hideBrowse: true });

      expect(await screen.findByText('waypoint')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /browse/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/titled for this project, so you can tell/i),
      ).not.toBeInTheDocument();
    });

    it('still links a suggestion in one click, and still surfaces that failure inline', async () => {
      jest
        .mocked(listProjects)
        .mockResolvedValue([
          project({
            id: 'p2',
            name: 'Old',
            repoPath: '/Users/a/code/waypoint',
          }),
        ]);
      jest
        .mocked(updateProject)
        .mockRejectedValue(
          new ApiError(
            'repoPath is not a git repository: /Users/a/code/waypoint',
          ),
        );

      mount({ hideBrowse: true });
      const suggestion = (await screen.findByText('waypoint')).closest(
        'button',
      )!;

      await act(async () => {
        fireEvent.click(suggestion);
      });

      expect(
        await screen.findByText('Something went wrong'),
      ).toBeInTheDocument();
      // No "choose a different folder" retry action without a dialog to
      // choose from — just the ability to dismiss and try another suggestion.
      expect(
        screen.queryByRole('button', { name: /choose a different folder/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Dismiss' }),
      ).toBeInTheDocument();
    });
  });
});
