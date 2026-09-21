import { useSyncExternalStore } from 'react';

/**
 * Which projects are folded in the sidebar — this device only, the same
 * localStorage-mirror shape as jiraStarred.ts.
 *
 * The founder's ask (2026-09-21): every seeded project rendered its whole
 * sub-nav, and four of them covered the rail. A project starts folded;
 * the one the current route is inside is shown open unless it was folded
 * by hand. A choice, once made, is remembered either way — so the map
 * stores `true` (open) and `false` (folded) explicitly and says nothing
 * about projects never touched.
 */
const KEY = 'waypoint:sidebar-projects';

type Choices = Record<string, boolean>;

function read(): Choices {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

function write(choices: Choices): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(choices));
  } catch {
    // Best-effort, like every other localStorage mirror here.
  }
}

let cache: Choices = read();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the project shows its sub-nav: the remembered choice, else open only when the route is inside it. */
export function isProjectOpen(
  choices: Choices,
  projectId: string,
  activeProjectId: string | null,
): boolean {
  return choices[projectId] ?? projectId === activeProjectId;
}

export function setProjectOpen(projectId: string, open: boolean): void {
  cache = { ...cache, [projectId]: open };
  write(cache);
  listeners.forEach((l) => l());
}

export function useSidebarProjectChoices(): Choices {
  return useSyncExternalStore(subscribe, () => cache);
}

/** `/projects/<id>/…` → `<id>`; null anywhere else. */
export function activeProjectIdFrom(pathname: string): string | null {
  const m = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!m || m[1] === 'archived') return null;
  return decodeURIComponent(m[1]);
}

/** Test seam. */
export function resetSidebarProjectsForTests(): void {
  cache = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}
