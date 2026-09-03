import { useEffect } from 'react';

const RECENTS_KEY = 'waypoint:recents';
const MAX_RECENTS = 20;

// Runtime list, not just a union: these values are persisted to localStorage,
// so a read has to be able to check them (see readRecents). Deriving the type
// from the array keeps the two from drifting apart.
export const RECENT_TYPES = ['ticket', 'page', 'cycle', 'module'] as const;

export type RecentType = (typeof RECENT_TYPES)[number];

export interface RecentEntry {
  type: RecentType;
  id: string;
  title: string;
  projectId: string;
  path: string;
  viewedAt: string; // ISO timestamp
}

function readRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop entries whose type this build no longer knows. The vocabulary
    // rename (docs/design/RENAME-STATE.md) changes these persisted values —
    // C2 'work-item' -> 'ticket', C3 'cycle'/'module' -> 'sprint'/'workstream'
    // — and a stale entry read back verbatim reaches Home's
    // RECENT_TYPE_ICON[type] lookup as undefined, which renders <undefined />
    // and takes the page down. Recents are a best-effort cache; forgetting a
    // superseded row is the right failure.
    return (parsed as RecentEntry[]).filter((entry) =>
      (RECENT_TYPES as readonly string[]).includes(entry?.type),
    );
  } catch {
    return [];
  }
}

/**
 * Records (or bumps) a view-history entry. De-dupes by type+id so re-visiting
 * something just moves it to the top instead of creating a duplicate row.
 */
export function recordRecent(entry: Omit<RecentEntry, 'viewedAt'>): void {
  const existing = readRecents().filter((r) => !(r.type === entry.type && r.id === entry.id));
  const next = [{ ...entry, viewedAt: new Date().toISOString() }, ...existing].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable/full — recents tracking is best-effort only.
  }
}

/** Most-recently-viewed entries, newest first. */
export function listRecents(limit = 5): RecentEntry[] {
  return readRecents()
    .sort((a, b) => new Date(b.viewedAt).getTime() - new Date(a.viewedAt).getTime())
    .slice(0, limit);
}

/**
 * Records a view-history entry once per mount/identity change. Pass `null`
 * while the entity hasn't loaded yet to skip recording.
 */
export function useRecordRecent(entry: Omit<RecentEntry, 'viewedAt'> | null): void {
  useEffect(() => {
    if (!entry) return;
    recordRecent(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.type, entry?.id, entry?.title, entry?.projectId, entry?.path]);
}
