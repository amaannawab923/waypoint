import { useEffect } from 'react';

const RECENTS_KEY = 'waypoint:recents';
const MAX_RECENTS = 20;

export type RecentType = 'work-item' | 'page' | 'cycle' | 'module';

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
    return Array.isArray(parsed) ? (parsed as RecentEntry[]) : [];
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
