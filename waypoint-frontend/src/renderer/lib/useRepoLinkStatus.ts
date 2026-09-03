import { useCallback, useEffect, useState } from 'react';

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
 * places. One hook, backed by the one main-process check
 * (repoPathStatus.ts) that copilotRunner.ts's actual send-time decision also
 * uses, so the badge, the card's gate, and what really happens on send can
 * never disagree about what "stale" means — only about how fresh their own
 * last check is.
 *
 * Checked on mount and on window focus, never on a timer. A folder deleted
 * while the app stays focused throughout can lag until the next focus or
 * navigation; that is accepted because this badge is UX, not a safety
 * boundary — copilotRunner.ts re-checks at the moment a message is actually
 * sent, so a stale badge can never cause Copilot to use a dead path.
 */
export function useRepoLinkStatus(repoPath: string | null): {
  status: RepoLinkStatus;
  recheck: () => void;
} {
  const [exists, setExists] = useState<boolean | null>(null);

  const check = useCallback(() => {
    if (!repoPath) return;
    setExists(null);
    // An IPC failure is not "stale": staying in `checking` refuses to
    // falsely accuse a link that may well be fine.
    const onUnavailable = () => setExists(null);
    try {
      window.electron.repo.checkPath(repoPath).then((r) => setExists(r.exists), onUnavailable);
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
