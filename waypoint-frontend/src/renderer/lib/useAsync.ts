import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
  reload: () => void;
  /**
   * Update `data` locally without refetching or touching `loading` — for
   * optimistic UI updates (e.g. drag-and-drop) where re-running `fn()` would
   * cause a jarring loading-skeleton flash for a change the caller already
   * knows the result of.
   */
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
}

/**
 * Calls an async mock-API function on mount and whenever `deps` change.
 * Every page in this app should load data through this (or a thin wrapper
 * around it) rather than calling `mock/api` functions ad hoc, so loading and
 * error states look and behave consistently everywhere.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const nonce = useRef(0);

  const run = useCallback(() => {
    const id = ++nonce.current;
    setLoading(true);
    setError(null);
    fn()
      .then((result) => {
        if (nonce.current === id) setData(result);
      })
      .catch((err) => {
        if (nonce.current === id) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (nonce.current === id) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { data, loading, error, reload: run, setData };
}
