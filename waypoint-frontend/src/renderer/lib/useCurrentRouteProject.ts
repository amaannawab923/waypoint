import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getProject } from '@/mock/api';

export interface CurrentRouteProject {
  projectId: string;
  /** Named on the in-chat card, which otherwise never says which project it writes to. */
  name: string;
  repoPath: string | null;
  /**
   * repoPath is set but no longer resolves to a usable directory. Sent-time
   * grounding and the in-chat card's gate both read this, so a moved checkout
   * stops silently degrading a run to an ungrounded one that still looks
   * grounded from here.
   */
  stale: boolean;
}

export interface UseCurrentRouteProjectResult {
  /** null while nothing project-scoped is open, or before the fetch lands. */
  project: CurrentRouteProject | null;
  /** Never rejects — a failed refetch leaves the last known value in place. */
  reload: () => Promise<void>;
}

/**
 * An unavailable or failing check resolves to "still there": refusing to
 * falsely accuse a link that may well be fine matters more here than
 * catching every stale one, since copilotRunner.ts re-checks independently
 * at the moment a message is actually sent.
 */
async function pathStillResolves(repoPath: string): Promise<boolean> {
  try {
    const result = await window.electron.repo.checkPath(repoPath);
    return result.exists;
  } catch {
    return true;
  }
}

/**
 * Which project's repo a Copilot message should be grounded in (V3).
 *
 * Copilot conversations are NOT project-scoped — copilot_conversations has
 * no projectId column, the panel is mounted once globally as a sibling of
 * AppShell's <Outlet/>, and one conversation can legitimately span several
 * projects. So repo context follows the *open page* instead: whatever
 * `/projects/:projectId/...` route is currently rendered, resolved fresh
 * rather than pinned to the conversation. Two messages in one conversation,
 * sent from two different projects' pages, can therefore ground in two
 * different repos — an accepted tradeoff, not an oversight.
 *
 * The panel still renders inside the router tree, so useParams() sees the
 * param; outside a project route it returns undefined and this resolves to
 * null (no repo, no card, no change from V2 behavior).
 *
 * Deliberately hand-rolled rather than built on useAsync: this hook lives in
 * the always-mounted Copilot panel, and useAsync unconditionally settles a
 * promise and flips its own loading flag on mount. With no project route
 * open — the common case, since the panel follows the user everywhere —
 * that would add an async re-render to a component that has nothing to
 * fetch. Here, no projectId means no promise and no state update at all.
 */
export function useCurrentRouteProject(): UseCurrentRouteProjectResult {
  const { projectId } = useParams<{ projectId?: string }>();
  const [loaded, setLoaded] = useState<CurrentRouteProject | null>(null);
  // Guards against a slow fetch for a project the user has already navigated
  // away from landing on top of a newer one's result.
  const generationRef = useRef(0);

  const reload = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!projectId) return;
    try {
      const project = await getProject(projectId);
      if (generationRef.current !== generation) return;
      const repoPath = project?.repoPath ?? null;
      // Folded into this same fetch rather than a second independent effect:
      // this hook already re-runs on projectId change and on CopilotPanel's
      // explicit reload() calls, which is the right cadence for staleness
      // too — per navigation and per link, never per message.
      const stale = repoPath ? !(await pathStillResolves(repoPath)) : false;
      if (generationRef.current !== generation) return;
      setLoaded({ projectId, name: project?.name ?? '', repoPath, stale });
    } catch {
      // Keep the last known value: a failed refetch must not read as "this
      // project has no repo linked", which would offer to link one that
      // already is.
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return {
    // Compared against the CURRENT param, so a result fetched for a project
    // the user has since navigated away from is never reported as the open
    // one.
    project: projectId && loaded?.projectId === projectId ? loaded : null,
    reload,
  };
}
