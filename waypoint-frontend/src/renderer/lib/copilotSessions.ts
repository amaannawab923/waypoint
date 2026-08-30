import { useCallback, useRef, useState } from 'react';

// Local, client-only multi-session store for the Copilot panel (issue #11,
// frontend-only pass). The backend's `copilot_conversations` table still has
// a unique constraint on `memberId` — it structurally cannot hold more than
// one conversation per user yet, so this deliberately does NOT call
// `getCopilotConversation`/`postCopilotUserMessage`/`postCopilotAssistantMessage`
// (mock/api.ts) at all. Those are left untouched for a later backend-backed
// migration; this is a parallel, additive local model so that migration can
// swap the storage layer underneath CopilotPanel.tsx without a rewrite of
// the UI built on top of it. This is a single-local-user Electron desktop
// app, so there is no sync/multi-device concern to solve here — plain
// localStorage, matching lib/recents.ts's existing convention.

export type CopilotSessionMessageRole = 'user' | 'assistant';

export interface CopilotSessionMessage {
  id: string;
  role: CopilotSessionMessageRole;
  content: string;
  createdAt: string;
}

export interface CopilotSession {
  id: string;
  title: string;
  pinned: boolean;
  order: number; // manual position within its current group (pinned, or a recency bucket)
  claudeSessionId: string | null; // Claude Code CLI session id, for --resume — same field the old single-conversation flow used
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

const STORAGE_KEY = 'waypoint:copilot-sessions';
export const DEFAULT_SESSION_TITLE = 'New session';
const TITLE_MAX_LENGTH = 60;

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

// Not crypto.randomUUID(): this app's `uuid` dependency ships ESM-only as of
// v14 (no CJS build at all, confirmed via node_modules/uuid/package.json),
// which ts-jest's default CJS transform can't consume without reconfiguring
// this project's shared Jest transformIgnorePatterns — too invasive for what
// this needs. crypto.randomUUID() was the other option, but it isn't
// reliably present in this project's jsdom test environment either
// (confirmed empirically; see the identical note in main/preload.test.ts).
// These ids are client-local only (never sent to a server, never compared
// across devices) — Date.now() plus a random suffix, the same
// non-cryptographic pattern already used for ToastHost.tsx's toast ids, is
// more than sufficient collision resistance for that.
function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function loadSessions(): CopilotSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CopilotSession[]) : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: CopilotSession[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // localStorage unavailable/full — session persistence is best-effort
    // only, matching lib/recents.ts's existing convention.
  }
}

// ---------------------------------------------------------------------------
// Recency bucketing and relative time
// ---------------------------------------------------------------------------

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
 * app, e.g. IntakePage.tsx) — that produces "about 2 hours ago", far too
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

function truncateTitle(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (!singleLine) return DEFAULT_SESSION_TITLE;
  if (singleLine.length <= TITLE_MAX_LENGTH) return singleLine;
  return `${singleLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Pure mutations — each takes the current list and returns a new one
// ---------------------------------------------------------------------------

function nextOrderForGroup(
  sessions: CopilotSession[],
  group: CopilotSessionGroupKey,
  now: Date,
): number {
  const siblingOrders = sessions
    .filter((s) => groupKeyForSession(s, now) === group)
    .map((s) => s.order);
  return siblingOrders.length > 0 ? Math.max(...siblingOrders) + 1 : 0;
}

export function createSession(
  sessions: CopilotSession[],
  now: Date = new Date(),
): { sessions: CopilotSession[]; session: CopilotSession } {
  const nowIso = now.toISOString();
  // New sessions always land at the top of today's unpinned group — every
  // existing member of that group is bumped down one, mirroring the
  // approved mockup's own createSession().
  const bumped = sessions.map((s) =>
    !s.pinned && bucketFor(s.updatedAt, now) === 'today'
      ? { ...s, order: s.order + 1 }
      : s,
  );
  const session: CopilotSession = {
    id: generateId('session'),
    title: DEFAULT_SESSION_TITLE,
    pinned: false,
    order: 0,
    claudeSessionId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messages: [],
  };
  return { sessions: [session, ...bumped], session };
}

/** Blank (whitespace-only) input is a no-op, matching the mockup's commitRename — it never clears a title outright. */
export function renameSession(
  sessions: CopilotSession[],
  id: string,
  rawTitle: string,
): CopilotSession[] {
  const title = rawTitle.trim().slice(0, TITLE_MAX_LENGTH);
  if (!title) return sessions;
  return sessions.map((s) => (s.id === id ? { ...s, title } : s));
}

/** Pinning/unpinning moves the session to the bottom of its destination group, same as the mockup's togglePin(). */
export function togglePinSession(
  sessions: CopilotSession[],
  id: string,
  now: Date = new Date(),
): CopilotSession[] {
  const target = sessions.find((s) => s.id === id);
  if (!target) return sessions;
  const pinned = !target.pinned;
  const destination: CopilotSessionGroupKey = pinned
    ? 'pinned'
    : bucketFor(target.updatedAt, now);
  const order = nextOrderForGroup(
    sessions.filter((s) => s.id !== id),
    destination,
    now,
  );
  return sessions.map((s) => (s.id === id ? { ...s, pinned, order } : s));
}

export function deleteSession(
  sessions: CopilotSession[],
  id: string,
): CopilotSession[] {
  return sessions.filter((s) => s.id !== id);
}

/**
 * Reorders within a single group only — dragging a session onto a target in
 * a *different* group is a no-op (moving between pinned/unpinned happens
 * only via togglePinSession, never by dragging across that boundary).
 */
export function reorderSessionsWithinGroup(
  sessions: CopilotSession[],
  sourceId: string,
  targetId: string,
  group: CopilotSessionGroupKey,
  now: Date = new Date(),
): CopilotSession[] {
  if (sourceId === targetId) return sessions;

  const groupIds = sessions
    .filter((s) => groupKeyForSession(s, now) === group)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.id);
  const sourceIndex = groupIds.indexOf(sourceId);
  const targetIndex = groupIds.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) return sessions;

  const reordered = groupIds.filter((id) => id !== sourceId);
  reordered.splice(targetIndex, 0, sourceId);
  const orderById = new Map(reordered.map((id, index) => [id, index]));

  return sessions.map((s) => {
    const order = orderById.get(s.id);
    return order === undefined ? s : { ...s, order };
  });
}

/**
 * Appends a message and bumps `updatedAt` (which is what re-buckets the row
 * in the list). A session's very first user message also auto-titles it
 * from that message's content, truncated — the epic's own suggested
 * auto-titling approach — but only while the title is still the untouched
 * default, so it never clobbers a title the user explicitly set.
 */
export function appendMessage(
  sessions: CopilotSession[],
  sessionId: string,
  message: { role: CopilotSessionMessageRole; content: string },
  now: Date = new Date(),
): CopilotSession[] {
  const nowIso = now.toISOString();
  return sessions.map((s) => {
    if (s.id !== sessionId) return s;
    const full: CopilotSessionMessage = {
      id: generateId('msg'),
      role: message.role,
      content: message.content,
      createdAt: nowIso,
    };
    const shouldAutoTitle =
      message.role === 'user' &&
      s.messages.length === 0 &&
      s.title === DEFAULT_SESSION_TITLE;
    return {
      ...s,
      title: shouldAutoTitle ? truncateTitle(message.content) : s.title,
      messages: [...s.messages, full],
      updatedAt: nowIso,
    };
  });
}

export function setClaudeSessionId(
  sessions: CopilotSession[],
  sessionId: string,
  claudeSessionId: string | null,
): CopilotSession[] {
  return sessions.map((s) =>
    s.id === sessionId ? { ...s, claudeSessionId } : s,
  );
}

// ---------------------------------------------------------------------------
// React hook — thin stateful wrapper over the pure functions above
// ---------------------------------------------------------------------------

export interface UseCopilotSessionsResult {
  sessions: CopilotSession[];
  createSession: () => CopilotSession;
  renameSession: (id: string, title: string) => void;
  togglePinSession: (id: string) => void;
  deleteSession: (id: string) => void;
  reorderSessionsWithinGroup: (
    sourceId: string,
    targetId: string,
    group: CopilotSessionGroupKey,
  ) => void;
  appendMessage: (
    sessionId: string,
    message: { role: CopilotSessionMessageRole; content: string },
  ) => void;
  setClaudeSessionId: (
    sessionId: string,
    claudeSessionId: string | null,
  ) => void;
}

/**
 * Owns the session list as React state, backed by localStorage. Every
 * mutating action reads from `sessionsRef` (not `sessions` from closure) so
 * two actions fired in quick succession (e.g. appendMessage right after
 * createSession) never operate on a stale snapshot from before React has
 * re-rendered — the same class of bug useAsync.ts's `nonce` ref guards
 * against, just for synchronous writes instead of async ones.
 */
export function useCopilotSessions(): UseCopilotSessionsResult {
  const [sessions, setSessions] = useState<CopilotSession[]>(() =>
    loadSessions(),
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const persist = useCallback((next: CopilotSession[]) => {
    sessionsRef.current = next;
    setSessions(next);
    saveSessions(next);
  }, []);

  const createSessionAction = useCallback(() => {
    const { sessions: next, session } = createSession(sessionsRef.current);
    persist(next);
    return session;
  }, [persist]);

  const renameSessionAction = useCallback(
    (id: string, title: string) => {
      persist(renameSession(sessionsRef.current, id, title));
    },
    [persist],
  );

  const togglePinSessionAction = useCallback(
    (id: string) => {
      persist(togglePinSession(sessionsRef.current, id));
    },
    [persist],
  );

  const deleteSessionAction = useCallback(
    (id: string) => {
      persist(deleteSession(sessionsRef.current, id));
    },
    [persist],
  );

  const reorderAction = useCallback(
    (sourceId: string, targetId: string, group: CopilotSessionGroupKey) => {
      persist(
        reorderSessionsWithinGroup(
          sessionsRef.current,
          sourceId,
          targetId,
          group,
        ),
      );
    },
    [persist],
  );

  const appendMessageAction = useCallback(
    (
      sessionId: string,
      message: { role: CopilotSessionMessageRole; content: string },
    ) => {
      persist(appendMessage(sessionsRef.current, sessionId, message));
    },
    [persist],
  );

  const setClaudeSessionIdAction = useCallback(
    (sessionId: string, claudeSessionId: string | null) => {
      persist(
        setClaudeSessionId(sessionsRef.current, sessionId, claudeSessionId),
      );
    },
    [persist],
  );

  return {
    sessions,
    createSession: createSessionAction,
    renameSession: renameSessionAction,
    togglePinSession: togglePinSessionAction,
    deleteSession: deleteSessionAction,
    reorderSessionsWithinGroup: reorderAction,
    appendMessage: appendMessageAction,
    setClaudeSessionId: setClaudeSessionIdAction,
  };
}
