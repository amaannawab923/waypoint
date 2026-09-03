import { useEffect, useRef, useState } from 'react';
import { updateProject } from '@/mock/api';
import {
  describeRepoLinkError,
  type RepoLinkErrorCopy,
} from '@/lib/repoLinkErrors';
import type {
  ChooseFolderOptions,
  RepoDescribeResult,
} from '../../../../main/repoLink';

/**
 * The one write path behind every way of linking a folder — a suggestion
 * click, Browse…, Change folder…, Relocate… — so all four share the same
 * error handling, the same pre-flight hint, and the same in-flight state
 * rather than each re-implementing the updateProject dance.
 */
export function useRepoLink(
  projectId: string,
  onLinked: (path: string) => void,
) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<RepoLinkErrorCopy | null>(null);
  // Set while a PATCH is in flight for a folder whose local .git check came
  // back empty. Advisory only: the request goes out regardless, and the
  // backend's answer is still the only one that decides anything.
  const [checkingNonRepo, setCheckingNonRepo] = useState(false);

  async function link(pickedPath: string, looksLikeGitRepo = true) {
    if (saving) return;
    setSaving(true);
    setError(null);
    setCheckingNonRepo(!looksLikeGitRepo);
    try {
      await updateProject(
        projectId,
        { repoPath: pickedPath },
        { silent: true },
      );
      onLinked(pickedPath);
    } catch (err) {
      setError(describeRepoLinkError(err));
    } finally {
      setSaving(false);
      setCheckingNonRepo(false);
    }
  }

  async function browse(opts: ChooseFolderOptions) {
    if (saving) return;
    const picked = await window.electron.repo.chooseFolder(opts);
    if (picked.canceled) return;
    // Explicitly `!== false`, not truthiness: an absent hint means "no
    // opinion", which must not read as "this isn't a repo".
    await link(picked.path, picked.looksLikeGitRepo !== false);
  }

  return {
    saving,
    error,
    checkingNonRepo,
    link,
    browse,
    dismissError: () => setError(null),
  };
}

export type UnlinkPhase = 'idle' | 'confirming' | 'undoable';

const UNDO_SECONDS = 5;

/**
 * The mirror of useRepoLink: one unlink path shared by the settings card
 * (which confirms first) and the stale card (which doesn't — the link is
 * already known-broken, so there is nothing left to talk the user out of).
 *
 * The PATCH fires the instant the user commits, never at the end of the undo
 * window. The copy promises Copilot stops reading this code, and a deferred
 * write would leave it still reading for five seconds while the UI claimed
 * otherwise. Undo is a genuine second write restoring the previous path —
 * cheap, since nothing else destroys that value.
 *
 * `onChanged` (which reloads the owning project and can swap this card out
 * for the unlinked picker) is deliberately NOT called at commit time — only
 * once the window resolves, via undo or expiry. Calling it immediately would
 * have the parent re-render on `repoPath` going null before this component's
 * own `undoable` phase ever paints, unmounting the Undo strip it's about to
 * show. The backend write itself isn't delayed, only the parent's picture of
 * it — the badge and header can lag a few seconds on an in-flight unlink the
 * same way they already do on window focus, which is fine for UX, not a
 * safety boundary.
 *
 * `onChanged` is read through a ref inside the countdown effect, not listed
 * as an effect dependency: every caller today happens to pass a fresh
 * function identity on every render (Codebase.tsx's onChanged is a plain
 * function declaration, not useCallback'd), and an effect keyed on that
 * identity would tear down and restart its pending setTimeout on ANY
 * re-render of the host during the window — including one caused by nothing
 * more than a window-focus recheck elsewhere on the page. Under sustained
 * re-rendering the countdown would never reach zero, leaving the backend
 * already unlinked while the UI still showed the pre-unlink state
 * indefinitely. The ref makes the countdown correct regardless of whether a
 * caller remembers to memoize its callback.
 */
export function useRepoUnlink(
  projectId: string,
  repoPath: string,
  onChanged: () => void,
) {
  const [phase, setPhase] = useState<UnlinkPhase>('idle');
  const [secondsLeft, setSecondsLeft] = useState(UNDO_SECONDS);
  const [error, setError] = useState<RepoLinkErrorCopy | null>(null);
  const [busy, setBusy] = useState(false);
  // Captured at commit time rather than read from props, which are already
  // null by the time Undo is clickable.
  const previousPathRef = useRef(repoPath);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    if (phase !== 'undoable') return undefined;
    if (secondsLeft === 0) {
      setPhase('idle');
      onChangedRef.current();
      return undefined;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [phase, secondsLeft]);

  async function unlink() {
    if (busy) return;
    previousPathRef.current = repoPath;
    setBusy(true);
    setError(null);
    try {
      await updateProject(projectId, { repoPath: null }, { silent: true });
      setSecondsLeft(UNDO_SECONDS);
      setPhase('undoable');
    } catch (err) {
      setError(describeRepoLinkError(err));
      setPhase('idle');
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    // Guards the race against expiry: if the countdown's zero-second render
    // already fired (moving phase to 'idle' and calling onChanged to reload
    // the owning project as unlinked) in the same tick Undo was clicked, the
    // PATCH below would still succeed — backend linked, UI already showing
    // the unlinked picker, nothing left to correct it. Bailing out here means
    // a click that loses this race is simply too late, the same as it would
    // be a moment after the strip itself had already unmounted.
    if (busy || phase !== 'undoable') return;
    setBusy(true);
    setError(null);
    try {
      await updateProject(
        projectId,
        { repoPath: previousPathRef.current },
        { silent: true },
      );
      setPhase('idle');
      onChanged();
    } catch (err) {
      setError(describeRepoLinkError(err));
    } finally {
      setBusy(false);
    }
  }

  return {
    phase,
    secondsLeft,
    error,
    busy,
    askToConfirm: () => setPhase('confirming'),
    keepIt: () => setPhase('idle'),
    unlink,
    undo,
  };
}

/**
 * Branch / last commit / tracked files for a linked checkout. Every field
 * degrades to null independently in the main process (a repo with no commits
 * yet, a detached HEAD, no `git` on PATH), and callers omit a chip entirely
 * rather than rendering "unknown" — an accurate absence beats a broken-
 * looking value.
 */
export function useRepoDescribe(
  repoPath: string | null,
  enabled = true,
): RepoDescribeResult | null {
  const [described, setDescribed] = useState<RepoDescribeResult | null>(null);

  useEffect(() => {
    if (!repoPath || !enabled) {
      setDescribed(null);
      return undefined;
    }
    let cancelled = false;
    // Never blocks or gates anything: a failed describe just leaves the card
    // without its chips.
    try {
      window.electron.repo.describe(repoPath).then(
        (result) => {
          if (!cancelled) setDescribed(result);
        },
        () => {},
      );
    } catch {
      // Bridge unavailable — same outcome as a rejected describe.
    }
    return () => {
      cancelled = true;
    };
  }, [repoPath, enabled]);

  return described;
}
