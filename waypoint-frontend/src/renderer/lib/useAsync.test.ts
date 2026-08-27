import { act, renderHook, waitFor } from '@testing-library/react';
import { useAsync } from './useAsync';

/** A promise plus its resolve/reject, for controlling settlement timing by hand. */
function deferred<T>() {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

describe('useAsync', () => {
  it('starts in a loading state with no data or error', () => {
    const { result } = renderHook(() =>
      useAsync(() => new Promise<string>(() => {}), []),
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('resolves into data and clears loading on success', async () => {
    const fn = jest.fn().mockResolvedValue('hello');
    const { result } = renderHook(() => useAsync(fn, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBe('hello');
    expect(result.current.error).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('captures a rejection as `error`, not a thrown/unhandled rejection', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAsync(fn, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.data).toBeUndefined();
  });

  it('wraps a non-Error rejection in an Error', async () => {
    const fn = jest.fn().mockRejectedValue('a plain string rejection');
    const { result } = renderHook(() => useAsync(fn, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('a plain string rejection');
  });

  it('refetches when a dep changes', async () => {
    const fn = jest
      .fn()
      .mockImplementation((n: number) => Promise.resolve(n * 10));
    const { result, rerender } = renderHook(
      ({ dep }) => useAsync(() => fn(dep), [dep]),
      {
        initialProps: { dep: 1 },
      },
    );

    await waitFor(() => expect(result.current.data).toBe(10));
    expect(fn).toHaveBeenCalledTimes(1);

    rerender({ dep: 2 });

    await waitFor(() => expect(result.current.data).toBe(20));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Regression test: reload() used to return `void`, so `await reload()` in
  // CopilotPanel.handleSend resolved immediately instead of waiting for the
  // refetch — masking failures and racing the UI ahead of real data.
  describe('reload()', () => {
    it("returns a promise that doesn't resolve until the refetch settles", async () => {
      const first = deferred<string>();
      const fn = jest.fn().mockReturnValueOnce(first.promise);
      const { result } = renderHook(() => useAsync(fn, []));

      first.resolve('initial');
      await waitFor(() => expect(result.current.data).toBe('initial'));

      const second = deferred<string>();
      fn.mockReturnValueOnce(second.promise);

      let reloadSettled = false;
      let reloadPromise!: Promise<void>;
      act(() => {
        reloadPromise = result.current.reload();
      });
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      reloadPromise
        .then(() => {
          reloadSettled = true;
          return undefined;
        })
        .catch(() => undefined);

      // The reload is genuinely in flight: data is still the old value, and
      // the returned promise has not settled yet.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(reloadSettled).toBe(false);
      expect(result.current.data).toBe('initial');

      await act(async () => {
        second.resolve('reloaded');
        await reloadPromise;
      });

      expect(reloadSettled).toBe(true);
      expect(result.current.data).toBe('reloaded');
    });

    it('never rejects, even when the underlying fetch rejects', async () => {
      const fn = jest.fn().mockResolvedValueOnce('ok');
      const { result } = renderHook(() => useAsync(fn, []));
      await waitFor(() => expect(result.current.data).toBe('ok'));

      fn.mockRejectedValueOnce(new Error('reload failed'));

      let threw = false;
      await act(async () => {
        try {
          await result.current.reload();
        } catch {
          threw = true;
        }
      });

      expect(threw).toBe(false);
      expect(result.current.error?.message).toBe('reload failed');
      // The previously loaded data is left in place, not wiped out by the
      // failed reload — CopilotPanel relies on this to keep showing the
      // conversation while surfacing an inline "Couldn't refresh" retry.
      expect(result.current.data).toBe('ok');
    });

    it('clears a previous error as soon as a reload starts', async () => {
      const fn = jest.fn().mockRejectedValueOnce(new Error('first failure'));
      const { result } = renderHook(() => useAsync(fn, []));
      await waitFor(() => expect(result.current.error).not.toBeNull());

      const retry = deferred<string>();
      fn.mockReturnValueOnce(retry.promise);

      act(() => {
        result.current.reload();
      });

      // error resets synchronously with the new run, not only once it
      // resolves — the retry banner should disappear immediately, not
      // linger until the new fetch finishes.
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(true);

      await act(async () => {
        retry.resolve('recovered');
        await Promise.resolve();
      });
    });

    it('ignores a stale in-flight response once a newer reload has started', async () => {
      const stale = deferred<string>();
      const fresh = deferred<string>();
      const fn = jest.fn().mockResolvedValueOnce('initial');
      const { result } = renderHook(() => useAsync(fn, []));
      await waitFor(() => expect(result.current.data).toBe('initial'));

      fn.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

      let staleReload!: Promise<void>;
      let freshReload!: Promise<void>;
      act(() => {
        staleReload = result.current.reload();
      });
      act(() => {
        freshReload = result.current.reload();
      });

      await act(async () => {
        fresh.resolve('fresh data');
        await freshReload;
      });
      expect(result.current.data).toBe('fresh data');

      await act(async () => {
        stale.resolve('stale data');
        await staleReload;
      });

      // The stale response must not clobber the fresher one that already landed.
      expect(result.current.data).toBe('fresh data');
    });
  });

  describe('setData()', () => {
    it('updates data locally without invoking fn again or touching loading', async () => {
      const fn = jest.fn().mockResolvedValue({ count: 1 });
      const { result } = renderHook(() => useAsync(fn, []));
      await waitFor(() => expect(result.current.data).toEqual({ count: 1 }));

      act(() => {
        result.current.setData({ count: 2 });
      });

      expect(result.current.data).toEqual({ count: 2 });
      expect(result.current.loading).toBe(false);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('supports an updater function based on the previous value', async () => {
      const fn = jest.fn().mockResolvedValue({ count: 1 });
      const { result } = renderHook(() => useAsync(fn, []));
      await waitFor(() => expect(result.current.data).toEqual({ count: 1 }));

      act(() => {
        result.current.setData((prev: { count: number } | undefined) => ({
          count: (prev?.count ?? 0) + 1,
        }));
      });

      expect(result.current.data).toEqual({ count: 2 });
    });
  });
});
