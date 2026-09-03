import { act, renderHook, waitFor } from '@testing-library/react';
import { updateProject } from '@/mock/api';
import { ApiError } from '@/mock/httpClient';
import { useRepoDescribe, useRepoLink, useRepoUnlink } from './useRepoLink';

jest.mock('@/mock/api', () => ({ updateProject: jest.fn() }));

const chooseFolder = jest.fn();
const describe_ = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  (window as unknown as { electron: unknown }).electron = {
    repo: { chooseFolder, describe: describe_ },
  };
});

describe('useRepoLink', () => {
  it('links a path through updateProject and reports it back to the caller', async () => {
    jest.mocked(updateProject).mockResolvedValue({} as never);
    const onLinked = jest.fn();
    const { result } = renderHook(() => useRepoLink('proj-1', onLinked));

    await act(async () => {
      await result.current.link('/code/waypoint');
    });

    expect(updateProject).toHaveBeenCalledWith(
      'proj-1',
      { repoPath: '/code/waypoint' },
      { silent: true },
    );
    expect(onLinked).toHaveBeenCalledWith('/code/waypoint');
  });

  // One bad pick should produce one error, inline, next to the action — not
  // a global toast carrying the same raw text as well.
  it('opts out of the global error toast so the failure stays inline', async () => {
    jest.mocked(updateProject).mockResolvedValue({} as never);
    const { result } = renderHook(() => useRepoLink('proj-1', jest.fn()));

    await act(async () => {
      await result.current.link('/code/waypoint');
    });

    expect(jest.mocked(updateProject).mock.calls[0][2]).toEqual({
      silent: true,
    });
  });

  it('maps a coded backend failure into human copy and keeps the raw message', async () => {
    jest
      .mocked(updateProject)
      .mockRejectedValue(
        new ApiError(
          'repoPath is not a git repository: /code/src',
          'repo_path_not_git_repo',
          '/code/src',
        ),
      );
    const onLinked = jest.fn();
    const { result } = renderHook(() => useRepoLink('proj-1', onLinked));

    await act(async () => {
      await result.current.link('/code/src');
    });

    expect(result.current.error?.title).toBe(
      "That folder isn't a git repository",
    );
    expect(result.current.error?.raw).toBe(
      'repoPath is not a git repository: /code/src',
    );
    expect(onLinked).not.toHaveBeenCalled();
    // A failed pick must leave the flow usable, not stuck saving.
    expect(result.current.saving).toBe(false);
  });

  it('clears a previous error when a later attempt starts', async () => {
    jest.mocked(updateProject).mockRejectedValueOnce(new Error('nope'));
    const { result } = renderHook(() => useRepoLink('proj-1', jest.fn()));
    await act(async () => {
      await result.current.link('/bad');
    });
    expect(result.current.error).not.toBeNull();

    jest.mocked(updateProject).mockResolvedValue({} as never);
    await act(async () => {
      await result.current.link('/good');
    });

    expect(result.current.error).toBeNull();
  });

  it('dismisses an error on request', async () => {
    jest.mocked(updateProject).mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useRepoLink('proj-1', jest.fn()));
    await act(async () => {
      await result.current.link('/bad');
    });

    act(() => result.current.dismissError());

    expect(result.current.error).toBeNull();
  });

  it('opens the dialog with the caller-supplied context and links what comes back', async () => {
    chooseFolder.mockResolvedValue({
      canceled: false,
      path: '/code/waypoint',
      looksLikeGitRepo: true,
    });
    jest.mocked(updateProject).mockResolvedValue({} as never);
    const { result } = renderHook(() => useRepoLink('proj-1', jest.fn()));

    await act(async () => {
      await result.current.browse({
        defaultPath: '/code',
        title: 'Link Waypoint to its local checkout',
      });
    });

    expect(chooseFolder).toHaveBeenCalledWith({
      defaultPath: '/code',
      title: 'Link Waypoint to its local checkout',
    });
    expect(updateProject).toHaveBeenCalledWith(
      'proj-1',
      { repoPath: '/code/waypoint' },
      { silent: true },
    );
  });

  it('does nothing at all when the dialog is canceled', async () => {
    chooseFolder.mockResolvedValue({ canceled: true });
    const { result } = renderHook(() => useRepoLink('proj-1', jest.fn()));

    await act(async () => {
      await result.current.browse({});
    });

    expect(updateProject).not.toHaveBeenCalled();
  });

  // Speed, not a second implementation of the backend's rule: the PATCH goes
  // out regardless and the backend's answer is the only one that decides.
  it('flags a folder with no .git while still sending the request anyway', async () => {
    chooseFolder.mockResolvedValue({
      canceled: false,
      path: '/code/not-a-repo',
      looksLikeGitRepo: false,
    });
    let resolvePatch!: () => void;
    jest.mocked(updateProject).mockReturnValue(
      new Promise((resolve) => {
        resolvePatch = () => resolve({} as never);
      }),
    );
    const { result } = renderHook(() => useRepoLink('proj-1', jest.fn()));

    let browsing!: Promise<void>;
    await act(async () => {
      browsing = result.current.browse({});
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.checkingNonRepo).toBe(true));
    expect(updateProject).toHaveBeenCalled();

    await act(async () => {
      resolvePatch();
      await browsing;
    });
    expect(result.current.checkingNonRepo).toBe(false);
  });

  // An absent hint means "no opinion", which must not read as "this isn't a
  // repo" — an older main process is the realistic way that happens.
  it('treats a missing looksLikeGitRepo hint as no opinion, not as a warning', async () => {
    chooseFolder.mockResolvedValue({ canceled: false, path: '/code/waypoint' });
    jest.mocked(updateProject).mockResolvedValue({} as never);
    const { result } = renderHook(() => useRepoLink('proj-1', jest.fn()));

    await act(async () => {
      await result.current.browse({});
    });

    expect(result.current.checkingNonRepo).toBe(false);
    expect(updateProject).toHaveBeenCalled();
  });
});

describe('useRepoUnlink', () => {
  it('writes the unlink immediately on commit, but defers onChanged until the window resolves', async () => {
    jest.mocked(updateProject).mockResolvedValue({} as never);
    const onChanged = jest.fn();
    const { result } = renderHook(() =>
      useRepoUnlink('proj-1', '/code/waypoint', onChanged),
    );

    await act(async () => {
      await result.current.unlink();
    });

    expect(updateProject).toHaveBeenCalledWith(
      'proj-1',
      { repoPath: null },
      { silent: true },
    );
    expect(result.current.phase).toBe('undoable');
    expect(result.current.secondsLeft).toBe(5);
    // Not called yet: an immediate call would have the owning card's parent
    // re-render on the now-null repoPath and unmount this hook's `undoable`
    // phase before the Undo strip it drives ever paints.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('restores the previous path on undo, as a genuine second write', async () => {
    jest.mocked(updateProject).mockResolvedValue({} as never);
    const { result } = renderHook(() =>
      useRepoUnlink('proj-1', '/code/waypoint', jest.fn()),
    );
    await act(async () => {
      await result.current.unlink();
    });

    await act(async () => {
      await result.current.undo();
    });

    expect(jest.mocked(updateProject).mock.calls[1]).toEqual([
      'proj-1',
      { repoPath: '/code/waypoint' },
      { silent: true },
    ]);
    expect(result.current.phase).toBe('idle');
  });

  it('counts the undo window down and closes it after five seconds', async () => {
    // Faked before the unlink, not after: the first tick is scheduled the
    // moment the phase flips, and a real timeout scheduled before this call
    // would never be advanced.
    jest.useFakeTimers();
    jest.mocked(updateProject).mockResolvedValue({} as never);
    const onChanged = jest.fn();
    const { result } = renderHook(() =>
      useRepoUnlink('proj-1', '/code/waypoint', onChanged),
    );
    await act(async () => {
      await result.current.unlink();
    });

    // One flush per tick: each timeout only schedules the next once the state
    // it set has actually rendered.
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
    }
    expect(result.current.secondsLeft).toBe(0);

    // The zero-second render is what closes the window — and only then does
    // the owning card's parent learn the unlink is final.
    await act(async () => {});
    expect(result.current.phase).toBe('idle');
    expect(onChanged).toHaveBeenCalled();
  });

  it('surfaces a failed unlink inline and stays in idle rather than claiming success', async () => {
    jest.mocked(updateProject).mockRejectedValue(new Error('server down'));
    const onChanged = jest.fn();
    const { result } = renderHook(() =>
      useRepoUnlink('proj-1', '/code/waypoint', onChanged),
    );

    await act(async () => {
      await result.current.unlink();
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.error?.body).toBe('server down');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('moves between idle and confirming without writing anything', () => {
    const { result } = renderHook(() =>
      useRepoUnlink('proj-1', '/code/waypoint', jest.fn()),
    );

    act(() => result.current.askToConfirm());
    expect(result.current.phase).toBe('confirming');

    act(() => result.current.keepIt());
    expect(result.current.phase).toBe('idle');
    expect(updateProject).not.toHaveBeenCalled();
  });
});

describe('useRepoDescribe', () => {
  it('describes a linked path on mount', async () => {
    describe_.mockResolvedValue({
      name: 'waypoint',
      displayPath: '~/code/waypoint',
      branch: 'main',
      lastCommitAt: '2026-08-30T10:00:00.000Z',
      trackedFileCount: 1284,
    });

    const { result } = renderHook(() =>
      useRepoDescribe('/Users/a/code/waypoint'),
    );

    await waitFor(() => expect(result.current?.branch).toBe('main'));
    expect(describe_).toHaveBeenCalledWith('/Users/a/code/waypoint');
  });

  it('describes nothing, and never calls the bridge, when disabled', () => {
    renderHook(() => useRepoDescribe('/code/waypoint', false));

    expect(describe_).not.toHaveBeenCalled();
  });

  // A failed describe just leaves the card without its chips — it never
  // blocks or gates anything.
  it('degrades to null when the describe rejects', async () => {
    describe_.mockRejectedValue(new Error('no git on PATH'));

    const { result } = renderHook(() => useRepoDescribe('/code/waypoint'));

    await waitFor(() => expect(describe_).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
