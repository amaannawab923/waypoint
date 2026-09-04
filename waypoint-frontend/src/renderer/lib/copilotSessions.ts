// Session list view-model + pure grouping/formatting helpers for the
// Copilot panel (issue #11). Session identity, messages, and titles are now
// backend-persisted (see data/api.ts's Copilot functions and
// useCopilotConversations.ts, the hook that fetches them and merges in
// local-only pin/order metadata from copilotSessionMeta.ts). What remains
// here is the pure, storage-agnostic logic for grouping/formatting a
// CopilotSession[] for the list UI — none of it changed by where the data
// underneath now comes from.

export type CopilotSessionMessageRole = 'user' | 'assistant';

export interface CopilotSessionMessage {
  id: string;
  role: CopilotSessionMessageRole;
  content: string;
  createdAt: string;
  // Present on backend-fetched messages (the DB's authoritative ordering —
  // see CopilotMessage in types/entities.ts); absent on optimistic local
  // appends until the next fetch. Proposal-card interleaving
  // (lib/copilotTranscript.ts) anchors on it, so it's surfaced here rather
  // than silently carried along untyped.
  seq?: number;
}

export interface CopilotSession {
  id: string;
  title: string;
  pinned: boolean;
  order: number; // manual position within its current group (pinned, or a recency bucket)
  claudeSessionId: string | null; // Claude Code CLI session id, for --resume
  createdAt: string;
  updatedAt: string; // drives which recency bucket a session renders in, recomputed at render time
  messages: CopilotSessionMessage[];
}

export type CopilotSessionGroupKey =
  'pinned' | 'today' | 'yesterday' | 'week' | 'older';

export interface CopilotSessionGroup {
  key: CopilotSessionGroupKey;
  label: string;
  sessions: CopilotSession[];
}

const BUCKET_LABELS: Record<
  Exclude<CopilotSessionGroupKey, 'pinned'>,
  string
> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Last 7 days',
  older: 'Older',
};

// Excludes 'pinned' — that group is handled separately (a pinned session's
// bucket is irrelevant to grouping, only to what its order is compared
// against once unpinned again).
const BUCKET_ORDER: Exclude<CopilotSessionGroupKey, 'pinned'>[] = [
  'today',
  'yesterday',
  'week',
  'older',
];

function startOfDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/** Which recency bucket `updatedAt` falls into, evaluated against `now`. */
export function bucketFor(
  updatedAt: string,
  now: Date = new Date(),
): Exclude<CopilotSessionGroupKey, 'pinned'> {
  const dayDiff = Math.round(
    (startOfDay(now) - startOfDay(new Date(updatedAt))) / (24 * 60 * 60 * 1000),
  );
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff <= 7) return 'week';
  return 'older';
}

/** Which group a session currently belongs to — 'pinned' wins over recency. */
export function groupKeyForSession(
  session: CopilotSession,
  now: Date = new Date(),
): CopilotSessionGroupKey {
  return session.pinned ? 'pinned' : bucketFor(session.updatedAt, now);
}

/**
 * Compact relative-time label for a session row (e.g. "35m", "2h", "6d").
 * Deliberately not date-fns's formatDistanceToNow (used elsewhere in this
 * app, e.g. RequestsPage.tsx) — that produces "about 2 hours ago", far too
 * wide for the mockup's single-token, tabular-nums time chip.
 */
export function formatRelativeTime(
  iso: string,
  now: Date = new Date(),
): string {
  const diffMs = Math.max(0, now.getTime() - new Date(iso).getTime());
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** Groups + sorts sessions for the session-list view: Pinned, then Today / Yesterday / Last 7 days / Older. */
export function groupSessions(
  sessions: CopilotSession[],
  now: Date = new Date(),
): CopilotSessionGroup[] {
  const groups: CopilotSessionGroup[] = [];

  const pinned = sessions
    .filter((s) => s.pinned)
    .sort((a, b) => a.order - b.order);
  if (pinned.length > 0)
    groups.push({ key: 'pinned', label: 'Pinned', sessions: pinned });

  BUCKET_ORDER.forEach((key) => {
    const rows = sessions
      .filter((s) => !s.pinned && bucketFor(s.updatedAt, now) === key)
      .sort((a, b) => a.order - b.order);
    if (rows.length > 0)
      groups.push({ key, label: BUCKET_LABELS[key], sessions: rows });
  });

  return groups;
}

/** Last message's content, single-lined — the row preview snippet, or null with no messages yet. */
export function lastMessagePreview(session: CopilotSession): string | null {
  const last = session.messages[session.messages.length - 1];
  return last ? last.content.replace(/\s+/g, ' ').trim() : null;
}
