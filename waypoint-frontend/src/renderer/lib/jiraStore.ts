import { useSyncExternalStore } from 'react';
import { useAsync } from '@/lib/useAsync';
import { getJiraConnectionStatus as fetchJiraConnectionStatus } from '@/data/jiraApi';
import type { JiraConnectionStatus } from '@/types/jira';

// A minimal, scoped client cache for the My Jira connection status — same
// Map/pub-sub shape as lib/proposalStore.ts (that file's own header comment
// explains why: not a general react-query replacement, just "read here,
// updated everywhere" for one piece of state two independent surfaces both
// need live). The sidebar's "My Jira" nav item and the future Connection
// settings page (phase 2) both need the same live `connected` value —
// whichever mounts first fetches it, and both stay in sync afterward with no
// refetch, the same guarantee proposalStore gives approve/reject.
//
// Modeled as a one-row Map (rather than a bare module-level variable) to
// keep the exact same subscribe/notify/useSyncExternalStore shape as
// proposalStore.ts, including its version-counter-gated snapshot caching.

type Listener = () => void;

const STATUS_KEY = 'status';
const byId = new Map<string, JiraConnectionStatus>();
const listeners = new Set<Listener>();

let version = 0;
let cachedSnapshot: JiraConnectionStatus | undefined;
let cachedSnapshotVersion = -1;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeJiraConnection(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Feed a fresh status into the store — an initial fetch, or the result of
 * connectJira()/disconnectJira() (phase 2's wizard and Connection page). */
export function setJiraConnection(status: JiraConnectionStatus): void {
  byId.set(STATUS_KEY, status);
  notify();
}

function getSnapshot(): JiraConnectionStatus | undefined {
  if (cachedSnapshotVersion !== version) {
    cachedSnapshot = byId.get(STATUS_KEY);
    cachedSnapshotVersion = version;
  }
  return cachedSnapshot;
}

/** Test-only escape hatch — see proposalStore.ts's resetProposalStoreForTests
 * for why this is needed (a singleton Map outlives any one `it()` block). */
export function resetJiraStoreForTests(): void {
  byId.clear();
  notify();
}

/** Live read of whatever the store currently holds — `undefined` until
 * something has fetched it at least once. Prefer `useLoadedJiraConnection`
 * below unless this component is guaranteed to mount after another one has
 * already triggered the fetch (e.g. deep in the My Jira page tree). */
export function useJiraConnection(): JiraConnectionStatus | undefined {
  return useSyncExternalStore(subscribeJiraConnection, getSnapshot, getSnapshot);
}

/** Convenience hook for a top-level mount point (Sidebar, MyJiraPage): fetches
 * the connection status once and feeds it into the shared store, then reads
 * back the live value the same way `useJiraConnection` does. Safe to call
 * from multiple mounted components at once — each fires its own fetch, but
 * every fetch upserts the same row, so whichever resolves last just
 * overwrites with an equivalent value. */
export function useLoadedJiraConnection(): JiraConnectionStatus | undefined {
  useAsync(async () => {
    const status = await fetchJiraConnectionStatus();
    setJiraConnection(status);
    return status;
  }, []);
  return useJiraConnection();
}
