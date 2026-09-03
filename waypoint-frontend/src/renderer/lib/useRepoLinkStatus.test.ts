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
    await waitFor(() => expect(result.current.status).toEqual({ kind: 'linked' }));
    expect(checkPath).toHaveBeenCalledWith('/code/waypoint');
  });

  it('reports stale when the stored path no longer resolves', async () => {
    checkPath.mockResolvedValue({ exists: false });

    const { result } = renderHook(() => useRepoLinkStatus('/code/gone'));

    await waitFor(() => expect(result.current.status).toEqual({ kind: 'stale' }));
  });

  // Refusing to falsely accuse a link that may well be fine matters more here
  // than catching every stale one: copilotRunner.ts re-checks independently at
  // send time, so this badge is UX, never a safety boundary.
  it('stays in checking rather than accusing the link when the IPC rejects', async () => {
    checkPath.mockRejectedValue(new Error('bridge exploded'));

    const { result } = renderHook(() => useRepoLinkStatus('/code/waypoint'));

    await waitFor(() => expect(checkPath).toHaveBeenCalled());
    expect(result.current.status).toEqual({ kind: 'checking' });
  });

  it('stays in checking when the bridge is missing entirely', async () => {
    stubBridge(false);

    const { result } = renderHook(() => useRepoLinkStatus('/code/waypoint'));

    expect(result.current.status).toEqual({ kind: 'checking' });
  });

  it('re-checks on window focus, so a folder deleted elsewhere is picked up on return', async () => {
    checkPath.mockResolvedValue({ exists: true });
    const { result } = renderHook(() => useRepoLinkStatus('/code/waypoint'));
    await waitFor(() => expect(result.current.status).toEqual({ kind: 'linked' }));

    checkPath.mockResolvedValue({ exists: false });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.status).toEqual({ kind: 'stale' }));
    expect(checkPath).toHaveBeenCalledTimes(2);
  });

  it('re-checks on demand via recheck()', async () => {
    checkPath.mockResolvedValue({ exists: false });
    const { result } = renderHook(() => useRepoLinkStatus('/code/waypoint'));
    await waitFor(() => expect(result.current.status).toEqual({ kind: 'stale' }));

    checkPath.mockResolvedValue({ exists: true });
    await act(async () => {
      result.current.recheck();
    });

    await waitFor(() => expect(result.current.status).toEqual({ kind: 'linked' }));
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
