import type { ActivityEntry, ActivityPayload } from '@/types/entities';

export type ActivityFilter = 'all' | 'changes' | 'comments';

/**
 * One person's burst of activity: consecutive entries close together in
 * time, made the same way (by hand, or through Copilot or a session).
 */
export interface ActivityCluster {
  key: string;
  actorId: string;
  via: ActivityPayload['via'];
  /** Newest first inside the cluster, like the list. */
  entries: ActivityEntry[];
  /** The newest entry's time: what the cluster header shows. */
  at: string;
}

export interface ActivityDay {
  label: string;
  clusters: ActivityCluster[];
}

/**
 * Reading order for changes made in one save (same timestamp): what it is,
 * then where it stands, then who and how it's tagged, then the rest.
 */
const VERB_ORDER: string[] = [
  'created',
  'title_changed',
  'description_changed',
  'state_changed',
  'priority_changed',
  'assignee_added',
  'assignee_removed',
  'label_added',
  'label_removed',
  'start_date_set',
  'due_date_set',
  'estimate_changed',
  'points_changed',
  'sprint_changed',
  'workstream_changed',
  'link_added',
  'link_removed',
  // A comment posted with files attached reads "commented", then "attached".
  'commented',
  'attachment_added',
  'attachment_removed',
  'sub_item_added',
];
const rank = (verb: string) => {
  const i = VERB_ORDER.indexOf(verb);
  return i === -1 ? VERB_ORDER.length : i;
};

/** Entries by the same person within this window read as one burst. */
export const CLUSTER_WINDOW_MS = 15 * 60_000;

export function isCommentEntry(e: ActivityEntry): boolean {
  return e.verb === 'commented';
}

export function filterActivity(entries: ActivityEntry[], filter: ActivityFilter): ActivityEntry[] {
  if (filter === 'comments') return entries.filter(isCommentEntry);
  if (filter === 'changes') return entries.filter((e) => !isCommentEntry(e));
  return entries;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", a weekday within the last week, else "12 Sept". */
export function activityDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/**
 * Newest first, sectioned by day, and within a day folded into one cluster
 * per person per burst — so "Maya changed status, set priority and added a
 * label" reads as one block instead of three rows that repeat her name.
 * A cluster never spans two days.
 */
export function groupActivity(entries: ActivityEntry[], now: Date = new Date()): ActivityDay[] {
  // Newest first; changes from one save (same instant) in reading order.
  const sorted = [...entries].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    const r = rank(a.verb) - rank(b.verb);
    return r !== 0 ? r : a.id < b.id ? -1 : 1;
  });
  const days: ActivityDay[] = [];
  for (const e of sorted) {
    const label = activityDayLabel(e.createdAt, now);
    let day = days[days.length - 1];
    if (!day || day.label !== label) {
      day = { label, clusters: [] };
      days.push(day);
    }
    const last = day.clusters[day.clusters.length - 1];
    const oldestInLast = last?.entries[last.entries.length - 1];
    const via = e.payload?.via;
    // The cluster header carries one "via" badge, so a person's own edits
    // never fold under a Copilot or session burst (or the other way round).
    const closeEnough =
      last &&
      oldestInLast &&
      last.actorId === e.actorId &&
      last.via === via &&
      new Date(oldestInLast.createdAt).getTime() - new Date(e.createdAt).getTime() <= CLUSTER_WINDOW_MS;
    if (last && closeEnough) last.entries.push(e);
    else day.clusters.push({ key: e.id, actorId: e.actorId, via, entries: [e], at: e.createdAt });
  }
  return days;
}

/**
 * The first `max` clusters across days, and how many entries (changes and
 * comments, not clusters) were held back, since that is what a reader counts.
 */
export function limitClusters(days: ActivityDay[], max: number): { days: ActivityDay[]; hidden: number } {
  let left = max;
  let hidden = 0;
  const count = (clusters: ActivityCluster[]) => clusters.reduce((n, c) => n + c.entries.length, 0);
  const out: ActivityDay[] = [];
  for (const day of days) {
    if (left <= 0) {
      hidden += count(day.clusters);
      continue;
    }
    const shown = day.clusters.slice(0, left);
    hidden += count(day.clusters.slice(shown.length));
    left -= shown.length;
    out.push({ ...day, clusters: shown });
  }
  return { days: out, hidden };
}
