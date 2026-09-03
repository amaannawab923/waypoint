import { act, renderHook, waitFor } from '@testing-library/react';
import { useRepoLinkStatus } from './useRepoLinkStatus';

const checkPath = jest.fn();

function stubBridge(present = true) {
  (window as unknown as { electron: unknown }).electron = present
    ? { repo: { checkPath } }
    : {};
}

beforeEach(() => {
  checkPath.mockReset();
  stubBridge();
});

describe('useRepoLinkStatus', () => {
  it('reports unlinked without ever touching the bridge when there is no path', () => {
    const { result } = renderHook(() => useRepoLinkStatus(null));

    expect(result.current.status).toEqual({ kind: 'unlinked' });
    expect(checkPath).not.toHaveBeenCalled();
  });

  it('checks a stored path on mount and reports linked when it resolves', async () => {
    checkPath.mockResolvedValue({ exists: true });

    const { result } = renderHook(() => useRepoLinkStatus('/code/waypoint'));

    expect(result.current.status).toEqual({ kind: 'checking' });
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'linked' }),
    );
    expect(checkPath).toHaveBeenCalledWith('/code/waypoint');
  });

  it('reports stale when the stored path no longer resolves', async () => {
    checkPath.mockResolvedValue({ exists: false });

    const { result } = renderHook(() => useRepoLinkStatus('/code/gone'));

    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'stale' }),
    );
  });

  // Refusing to falsely accuse a link that may well be fine matters more here
  // than catching every stale one: copilotRunner.ts re-checks independently at
  // send time, so this badge is UX, never a safety boundary. Matches
  // useCurrentRouteProject's pathStillResolves, which treats the same
  // failure the same way — a bridge outage must not read as "relink this"
  // any more than as "this folder is gone".
  it('treats an IPC rejection as still-linked rather than accusing the link', async () => {
    checkPath.mockRejectedValue(new Error('bridge exploded'));

    const { result } = renderHook(() => useRepoLinkStatus('/code/waypoint'));

    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'linked' }),
    );
  });

  it('treats a missing bridge the same way, rather than getting stuck in checking', async () => {
    stubBridge(false);

    const { result } = renderHook(() => useRepoLinkStatus('/code/waypoint'));

    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'linked' }),
    );
  });

  // The concrete failure this guards: Codebase.onLinked() calls recheck()
  // synchronously (bound to the OLD repoPath by then-stale closure) followed
  // by reloadProject(), which changes repoPath and starts a SECOND check —
  // two checks in flight, old path and new. Without a generation guard, the
  // old (dead) path's slower reply landing last would pin `stale` on the
  // freshly relocated path with nothing to correct it before the next focus.
  it('ignores a stale check whose reply lands after a newer one already started', async () => {
    let resolveFirst!: (v: { exists: boolean }) => void;
    checkPath.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ p }) => useRepoLinkStatus(p), {
      initialProps: { p: '/code/old' },
    });
    await waitFor(() => expect(checkPath).toHaveBeenCalledWith('/code/old'));

    checkPath.mockResolvedValue({ exists: true });
    rerender({ p: '/code/new' });
    await waitFor(() => expect(checkPath).toHaveBeenCalledWith('/code/new'));
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'linked' }),
    );

    // The old path's check finally resolves as gone — after the new path's
    // check already reported linked. It must not overwrite that answer.
    await act(async () => {
      resolveFirst({ exists: false });
    });

    expect(result.current.status).toEqual({ kind: 'linked' });
  });

  it('re-checks on window focus, so a folder deleted elsewhere is picked up on return', async () => {
    checkPath.mockResolvedValue({ exists: true });
    const { result } = renderHook(() => useRepoLinkStatus('/code/waypoint'));
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'linked' }),
    );

    checkPath.mockResolvedValue({ exists: false });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'stale' }),
    );
    expect(checkPath).toHaveBeenCalledTimes(2);
  });

  it('re-checks on demand via recheck()', async () => {
    checkPath.mockResolvedValue({ exists: false });
    const { result } = renderHook(() => useRepoLinkStatus('/code/waypoint'));
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'stale' }),
    );

    checkPath.mockResolvedValue({ exists: true });
    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'linked' }),
    );
  });

  it('re-checks when the path itself changes', async () => {
    checkPath.mockResolvedValue({ exists: true });
    const { rerender } = renderHook(({ p }) => useRepoLinkStatus(p), {
      initialProps: { p: '/code/a' },
    });
    await waitFor(() => expect(checkPath).toHaveBeenCalledWith('/code/a'));

    rerender({ p: '/code/b' });

    await waitFor(() => expect(checkPath).toHaveBeenCalledWith('/code/b'));
  });
});
