import { useAsync } from './useAsync';
import { listProjects } from '@/mock/api';
import type { Project } from '@/types/entities';

export interface RepoSuggestion {
  path: string;
  /** basename(path) — the folder name, which is what a user recognizes. */
  name: string;
  reason: 'name-match' | 'other-project';
  /** Present only when reason === 'other-project'. */
  otherProjectName?: string;
}

// Deliberately non-fuzzy: normalize both sides (lowercase, strip
// non-alphanumerics) and test substring containment either direction. A
// "Waypoint" project matches both a "waypoint" and a "waypoint-electron-v3"
// folder; "Atlas" matches "atlas-api" under this looser test where strict
// equality would miss it. Five lines of pure function, not something that
// justifies a fuzzy-match dependency.
function looksNamedFor(
  projectName: string,
  projectIdentifier: string,
  basename: string,
): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = norm(basename);
  if (!b) return false;
  const name = norm(projectName);
  const identifier = norm(projectIdentifier);
  return (
    (!!name && b.includes(name)) ||
    (!!identifier && b.includes(identifier)) ||
    (!!name && name.includes(b))
  );
}

/**
 * Repo-root candidates to offer instead of a cold OS dialog, derived
 * entirely from paths this workspace already knows: the `repoPath` other
 * projects are linked to. No filesystem scanning — "name matches project" is
 * string-matching against already-known basenames, not directory
 * enumeration, so this needs no new main-process capability at all.
 *
 * The honest cost is a one-time cliff: the very first repo ever linked on a
 * machine has no other project's path to suggest, so the strip is empty and
 * Browse is the only door — exactly today's behavior, not a regression.
 * Every link after the first gets suggestions.
 */
export function useRepoSuggestions(
  currentProjectId: string,
  currentProjectName: string,
  currentProjectIdentifier: string,
): { suggestions: RepoSuggestion[]; loading: boolean } {
  const { data: projects, loading } = useAsync(() => listProjects(), []);

  const suggestions = (projects ?? [])
    .filter(
      (p): p is Project & { repoPath: string } =>
        p.id !== currentProjectId && !!p.repoPath,
    )
    // Two projects can legitimately point at the same checkout (a monorepo
    // split across projects) — offer it once.
    .filter((p, i, arr) => arr.findIndex((q) => q.repoPath === p.repoPath) === i)
    .map((p): RepoSuggestion => {
      const name = p.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? p.repoPath;
      return looksNamedFor(currentProjectName, currentProjectIdentifier, name)
        ? { path: p.repoPath, name, reason: 'name-match' }
        : {
            path: p.repoPath,
            name,
            reason: 'other-project',
            otherProjectName: p.name,
          };
    })
    // Name matches first — the highest-confidence pick. The rest keep
    // listProjects' order; this list tops out at "however many other
    // projects exist" and never needs real ranking.
    .sort(
      (a, b) =>
        (a.reason === 'name-match' ? 0 : 1) - (b.reason === 'name-match' ? 0 : 1),
    );

  return { suggestions, loading };
}
