/**
 * Serializes async work by key within this one Electron main process — the
 * shape ROAD-131's per-ticket dispatch lock (dispatch.ts's
 * `withTicketDispatchLock`) proved out, generalized here so ROAD-XXX's
 * per-run resume lock (runLock.ts) can reuse the exact same mechanics
 * rather than a second, subtly different implementation.
 *
 * A rejected call does not jam the queue for its key: `fn` runs on either
 * settlement of the previous call, so the next one still runs once it is
 * its turn. Not reentrant — a caller must never call `serializeBy` again
 * for the same `queues`/`key` from inside `fn` — and scoped to this one
 * process: two Electron instances, or any other client of the same
 * backend, walk straight past a lock that only lives in this Map. See
 * each call site's own doc comment for what invariant its key actually
 * protects and whether that scope is enough.
 */
export function serializeBy<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const settled = previous.then(fn, fn);
  const bare = settled.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, bare);
  // Fire-and-forget cleanup, the same accepted shape dispatch.ts's own
  // pre-extraction version of this lock used (its own comment: this
  // trips `no-void`/`promise/always-return` for the same reason, and was
  // left as-is rather than fought — `bare` can never reject, so there is
  // nothing this callback could usefully return or throw.
  /* eslint-disable no-void, promise/always-return -- see the comment above */
  void bare.then(() => {
    if (queues.get(key) === bare) queues.delete(key);
  });
  /* eslint-enable no-void, promise/always-return */
  return settled;
}

/** True while `key` has work enqueued or in flight in `queues` — reads the exact state `serializeBy` writes, for a caller that would rather skip than wait its turn (see `tryWithRunLock` in runLock.ts). */
export function isBusy(
  queues: Map<string, Promise<unknown>>,
  key: string,
): boolean {
  return queues.has(key);
}
