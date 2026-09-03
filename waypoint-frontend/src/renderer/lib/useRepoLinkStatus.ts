import { useCallback, useEffect, useRef, useState } from 'react';

export type RepoLinkStatus =
  | { kind: 'unlinked' }
  /** repoPath is set, but the check hasn't resolved yet. */
  | { kind: 'checking' }
  | { kind: 'linked' }
  /** repoPath is set and repo:check-path said it no longer resolves. */
  | { kind: 'stale' };

/**
 * "Is this project's repoPath currently a usable directory" — the header
 * badge and the in-chat card's gate are the same question asked from two
 * places. Both are backed by the one main-process check (repoPathStatus.ts)
 * that copilotRunner.ts's actual send-time decision also uses, so the two
 * can never disagree about what "usable" MEANS — only, briefly, about how
 * fresh their own last check is.
 *
 * Checked on mount and on window focus, never on a timer. A folder deleted
 * while the app stays focused throughout can lag until the next focus or
 * navigation; that is accepted because this badge is UX, not a safety
 * boundary — copilotRunner.ts re-checks at the moment a message is actually
 * sent, so a stale badge can never cause Copilot to use a dead path.
 *
 * An IPC failure resolves to "still there" (matching
 * useCurrentRouteProject's pathStillResolves), not "stale" and not stuck in
 * `checking` forever: refusing to falsely accuse a link that may well be
 * fine matters the same way in both places, and a bridge outage should not
 * read to the user as "you need to link this again" any more than as
 * "this folder is gone".
 */
export function useRepoLinkStatus(repoPath: string | null): {
  status: RepoLinkStatus;
  recheck: () => void;
} {
  const [exists, setExists] = useState<boolean | null>(null);
  // Guards against a check for an EARLIER repoPath resolving after a check
  // for the current one already started (e.g. Relocate's old-path check
  // landing after the new path's) — only the most recently started check's
  // answer is allowed to land.
  const generationRef = useRef(0);

  const check = useCallback(() => {
    if (!repoPath) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    setExists(null);
    const settle = (value: boolean) => {
      if (generationRef.current === generation) setExists(value);
    };
    const onUnavailable = () => settle(true);
    try {
      window.electron.repo
        .checkPath(repoPath)
        .then((r) => settle(r.exists), onUnavailable);
    } catch {
      onUnavailable();
    }
  }, [repoPath]);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [check]);

  const status: RepoLinkStatus = !repoPath
    ? { kind: 'unlinked' }
    : exists === null
      ? { kind: 'checking' }
      : exists
        ? { kind: 'linked' }
        : { kind: 'stale' };

  return { status, recheck: check };
}
