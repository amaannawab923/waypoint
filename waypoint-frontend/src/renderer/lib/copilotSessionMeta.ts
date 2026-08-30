import type { CopilotSession, CopilotSessionGroupKey } from './copilotSessions';
import { bucketFor } from './copilotSessions';

// Local-only UI metadata for the Copilot session list (issue #11's backend
// migration) — pin state and manual drag-reorder position. Neither is in
// issue #11's acceptance criteria or the backend schema; they're UX the
// earlier local-only pass built beyond the issue's literal ask, and there's
// no reason a personal list-ordering preference needs to survive a device
// change. Kept as a small side-table keyed by conversation id, decoupled
// from the conversations/messages themselves, which now live on the
// backend — same plain-localStorage convention as lib/recents.ts.

export interface CopilotSessionMetaEntry {
  pinned: boolean;
  order: number;
}

export type CopilotSessionMetaMap = Record<string, CopilotSessionMetaEntry>;

const STORAGE_KEY = 'waypoint:copilot-session-meta';
const DEFAULT_ENTRY: CopilotSessionMetaEntry = { pinned: false, order: 0 };

export function loadMeta(): CopilotSessionMetaMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Explicitly not-an-array, not just typeof 'object' — an array passes
    // that check too (typeof [] === 'object'), which would otherwise let a
    // malformed/corrupted stored array through as a bogus numeric-keyed map.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as CopilotSessionMetaMap)
      : {};
  } catch {
    return {};
  }
}

export function saveMeta(meta: CopilotSessionMetaMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // localStorage unavailable/full — list ordering/pin state is best-effort
    // only, matching lib/recents.ts's existing convention.
  }
}

/** A freshly-fetched conversation the user hasn't pinned/reordered yet defaults to unpinned, order 0. */
export function getMeta(
  meta: CopilotSessionMetaMap,
  id: string,
): CopilotSessionMetaEntry {
  return meta[id] ?? DEFAULT_ENTRY;
}

export function removeMeta(
  meta: CopilotSessionMetaMap,
  id: string,
): CopilotSessionMetaMap {
  if (!(id in meta)) return meta;
  const { [id]: _dropped, ...rest } = meta;
  return rest;
}

function groupKeyFor(
  meta: CopilotSessionMetaMap,
  session: CopilotSession,
  now: Date,
): CopilotSessionGroupKey {
  return getMeta(meta, session.id).pinned
    ? 'pinned'
    : bucketFor(session.updatedAt, now);
}

function nextOrderForGroup(
  meta: CopilotSessionMetaMap,
  sessions: CopilotSession[],
  group: CopilotSessionGroupKey,
  now: Date,
): number {
  const siblingOrders = sessions
    .filter((s) => groupKeyFor(meta, s, now) === group)
    .map((s) => getMeta(meta, s.id).order);
  return siblingOrders.length > 0 ? Math.max(...siblingOrders) + 1 : 0;
}

/** Pinning/unpinning moves the session to the bottom of its destination group. */
export function togglePin(
  meta: CopilotSessionMetaMap,
  sessions: CopilotSession[],
  id: string,
  now: Date = new Date(),
): CopilotSessionMetaMap {
  const session = sessions.find((s) => s.id === id);
  if (!session) return meta;
  const pinned = !getMeta(meta, id).pinned;
  const destination: CopilotSessionGroupKey = pinned
    ? 'pinned'
    : bucketFor(session.updatedAt, now);
  const order = nextOrderForGroup(
    meta,
    sessions.filter((s) => s.id !== id),
    destination,
    now,
  );
  return { ...meta, [id]: { pinned, order } };
}

/**
 * Reorders within a single group only — dragging a session onto a target in
 * a *different* group is a no-op (moving between pinned/unpinned happens
 * only via togglePin, never by dragging across that boundary).
 */
export function reorderWithinGroup(
  meta: CopilotSessionMetaMap,
  sessions: CopilotSession[],
  sourceId: string,
  targetId: string,
  group: CopilotSessionGroupKey,
  now: Date = new Date(),
): CopilotSessionMetaMap {
  if (sourceId === targetId) return meta;

  const groupIds = sessions
    .filter((s) => groupKeyFor(meta, s, now) === group)
    .sort((a, b) => getMeta(meta, a.id).order - getMeta(meta, b.id).order)
    .map((s) => s.id);
  const sourceIndex = groupIds.indexOf(sourceId);
  const targetIndex = groupIds.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) return meta;

  const reordered = groupIds.filter((id) => id !== sourceId);
  reordered.splice(targetIndex, 0, sourceId);

  const next = { ...meta };
  reordered.forEach((id, index) => {
    next[id] = { pinned: getMeta(meta, id).pinned, order: index };
  });
  return next;
}
