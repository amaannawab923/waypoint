import { useSyncExternalStore } from 'react';
import { getProject } from '@/data/api';
import type { Project } from '@/types/entities';

// A minimal shared cache for the project list, same subscribe/notify
// pub-sub shape as lib/proposalStore.ts. It exists to solve one problem:
// the Sidebar renders every project's sub-nav from `primitiveCounts`
// (docs/design/waypoint-revamp-architecture.md §3.4), but Sidebar and
// whichever page just created a project's first sprint/workstream/view/doc/
// request are independently-mounted siblings under AppShell (Sidebar isn't
// inside ProjectLayout's <Outlet>, so ProjectLayout's own reloadProject
// doesn't reach it). Without a shared store, creating a project's first
// sprint would need a full app reload before its sidebar entry appeared —
// this is what makes "Add… → New Sprint creates one and the entry appears"
// (§3.4's own accept criterion) true with no such reload.
//
// What this module deliberately does NOT do: the initial fetch. Sidebar
// still owns calling listProjects() (via useAsync, for its loading state)
// and seeds the store with the result; every other reader/writer only ever
// upserts.

type Listener = () => void;

const byId = new Map<string, Project>();
const listeners = new Set<Listener>();

// Bumped on every mutation. getAllSnapshot only rebuilds its cached array
// when this has moved since the array was last built, so a component
// subscribed via useSyncExternalStore doesn't see a new array reference (and
// re-render) on every read when nothing in the store actually changed.
let version = 0;
let allSnapshot: Project[] = [];
let allSnapshotVersion = -1;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeProjects(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Seed/replace the store from a full `listProjects()` fetch — Sidebar does this once on mount. */
export function setProjects(rows: Project[]): void {
  byId.clear();
  for (const row of rows) byId.set(row.id, row);
  notify();
}

/** Upsert one or more rows — e.g. a mutation response that already carries the updated project. */
export function upsertProjects(rows: Project[]): void {
  if (rows.length === 0) return;
  for (const row of rows) byId.set(row.id, row);
  notify();
}

/**
 * Re-fetch one project and upsert it into the store. The shared refresh path
 * every "New sprint/workstream/view/doc/request" creation flow calls after
 * it succeeds, so a project that just gained its first row in a primitive
 * gets its `primitiveCounts` (and the Sidebar entry that depends on it)
 * updated live, with no page reload.
 */
export async function refreshProjectInStore(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (project) upsertProjects([project]);
}

function getAllSnapshot(): Project[] {
  if (allSnapshotVersion !== version) {
    allSnapshot = Array.from(byId.values());
    allSnapshotVersion = version;
  }
  return allSnapshot;
}

/** React binding: every project currently held by the store, live. */
export function useAllProjects(): Project[] {
  return useSyncExternalStore(
    subscribeProjects,
    getAllSnapshot,
    getAllSnapshot,
  );
}
