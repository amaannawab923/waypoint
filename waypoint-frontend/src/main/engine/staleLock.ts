import { promises as fs } from 'node:fs';

/**
 * Removes the daemon's `<socket>.lock` only when the process that took it
 * is gone — ROAD-50's stale-lock rule, tightened in review round 2.
 *
 * emdash's `start` takes the lock with `open(path, 'wx')` and writes its
 * own pid into it (`daemon/lock.ts:23-27`); it has no liveness check of
 * its own, so a `start` killed mid-flight leaves the file behind and every
 * later `start` times out on it after 5 s. The first draft removed the
 * file whenever the socket had just answered "not running" — which is
 * also exactly what the socket says while a `start` is genuinely
 * mid-flight (its `serve` has not bound yet). Verified live: removing a
 * live `start`'s lock lets a second `start` proceed, and that one's own
 * dead-file cleanup then unlinks the first daemon's socket — an orphan.
 *
 * So the pid decides. A lock naming a live process is left alone; a lock
 * naming a dead one, or one we cannot read a pid from, is removed. This
 * is the only place Waypoint deletes something the daemon owns.
 */
export interface StaleLockDeps {
  readFile?: (path: string) => Promise<string>;
  rm?: (path: string) => Promise<void>;
  /** `process.kill(pid, 0)` — throws ESRCH when there is no such process. */
  probePid?: (pid: number) => void;
}

export type StaleLockOutcome =
  | { kind: 'absent' }
  | { kind: 'removed'; reason: 'dead-pid' | 'unreadable' }
  | { kind: 'kept'; pid: number };

export async function removeStaleStartLock(
  lockPath: string,
  deps: StaleLockDeps = {},
): Promise<StaleLockOutcome> {
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  const rm = deps.rm ?? ((p: string) => fs.rm(p, { force: true }));
  const probePid = deps.probePid ?? ((pid: number) => process.kill(pid, 0));

  let content: string;
  try {
    content = await readFile(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'absent' };
    // Unreadable for another reason: a lock we cannot judge is a lock we
    // remove, the way the first draft always did — the alternative is a
    // `start` that can never succeed.
    await rm(lockPath);
    return { kind: 'removed', reason: 'unreadable' };
  }

  const pid = Number.parseInt(content.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    await rm(lockPath);
    return { kind: 'removed', reason: 'unreadable' };
  }
  try {
    probePid(pid);
    // Signal 0 delivered (or EPERM, which also means "exists"): a live
    // process holds this lock.
    return { kind: 'kept', pid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM')
      return { kind: 'kept', pid };
    await rm(lockPath);
    return { kind: 'removed', reason: 'dead-pid' };
  }
}
