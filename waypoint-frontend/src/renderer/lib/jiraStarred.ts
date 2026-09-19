import { useSyncExternalStore } from 'react';

// ROAD-158's Starred tab: local-only, this-device-only star state for Jira
// issues — the founder's own call over Jira issue properties ("far less new
// surface for a v1, easy to upgrade later if people actually want it to
// follow them across devices"). Same localStorage-cache shape as
// recents.ts, deliberately not shared code with it: recents is an
// automatic, capped, most-recent-first log a person never edits directly,
// while starring is a person's own explicit, uncapped, order-independent
// set — the two data shapes don't actually have anything in common beyond
// both being small localStorage-backed lists.

const STARRED_KEY = 'waypoint:jira-starred';

function readStarred(): Set<string> {
  try {
    const raw = localStorage.getItem(STARRED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

function writeStarred(keys: Set<string>): void {
  try {
    localStorage.setItem(STARRED_KEY, JSON.stringify([...keys]));
  } catch {
    // localStorage unavailable/full — starring is best-effort only, same
    // posture as recents.ts's own recordRecent.
  }
}

// A tiny in-memory mirror + subscriber list, the same shape jiraStore.ts
// uses for the connection snapshot — so every mounted star button and the
// Starred tab itself stay in sync the instant one of them toggles a key,
// without each re-reading and re-parsing localStorage on every render.
let cache = readStarred();
// A stable array snapshot, recomputed only when `cache` itself is
// reassigned — useSyncExternalStore requires getSnapshot to return a
// referentially stable value when nothing changed, and listJiraStarredKeys'
// own `[...cache]` is a fresh array on every call, not stable across renders
// that didn't touch the store at all.
let cacheSnapshot: string[] = [...cache];
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isJiraStarred(key: string): boolean {
  return cache.has(key);
}

/** Flips the key's starred state and returns what it is now. */
export function toggleJiraStarred(key: string): boolean {
  const next = new Set(cache);
  const nowStarred = !next.has(key);
  if (nowStarred) next.add(key);
  else next.delete(key);
  cache = next;
  cacheSnapshot = [...cache];
  writeStarred(cache);
  notify();
  return nowStarred;
}

/** Every starred key, in no particular order — the Starred tab sorts the
 *  real tickets it resolves them to, same as every other tab. */
export function listJiraStarredKeys(): string[] {
  return [...cache];
}

/** Live-subscribes to one key's starred state, for a star toggle button
 *  anywhere in the tree — re-renders only that button when the state it
 *  cares about actually changes. */
export function useJiraStarred(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => cache.has(key),
    () => false,
  );
}

/** Live-subscribes to the whole starred set — for the Starred tab, so
 *  unstarring a ticket from anywhere (its own drawer included) removes it
 *  from the tab immediately rather than only on the next mount. */
export function useJiraStarredKeys(): string[] {
  return useSyncExternalStore(
    subscribe,
    () => cacheSnapshot,
    () => [],
  );
}

/** Test-only escape hatch, matching jiraStore.ts's own resetJiraStoreForTests
 *  — a module-level Set otherwise outlives any one `it()` block. */
export function resetJiraStarredForTests(): void {
  cache = new Set();
  cacheSnapshot = [];
  writeStarred(cache);
  notify();
}
