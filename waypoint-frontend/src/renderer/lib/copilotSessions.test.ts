import {
  DEFAULT_SESSION_TITLE,
  appendMessage,
  bucketFor,
  createSession,
  deleteSession,
  formatRelativeTime,
  groupSessions,
  lastMessagePreview,
  loadSessions,
  reorderSessionsWithinGroup,
  saveSessions,
  renameSession,
  setClaudeSessionId,
  togglePinSession,
  type CopilotSession,
} from './copilotSessions';

// Built from local date parts, not a UTC ISO string: bucketFor()'s
// startOfDay() intentionally buckets by the *local* calendar day (what a
// real desktop user sitting in their own timezone would call "today"), via
// Date's local getFullYear/getMonth/getDate. Deriving every fixture in this
// file from NOW with local setDate/setHours (not their UTC counterparts)
// keeps that consistent, so these tests pass in any timezone rather than
// only in UTC.
const NOW = new Date(2026, 7, 26, 12, 0, 0);

function isoDaysAgo(days: number, hours = 0): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - days);
  d.setHours(d.getHours() - hours);
  return d.toISOString();
}

function session(overrides: Partial<CopilotSession> = {}): CopilotSession {
  return {
    id: 's1',
    title: 'Sprint 14 planning',
    pinned: false,
    order: 0,
    claudeSessionId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    messages: [],
    ...overrides,
  };
}

describe('bucketFor', () => {
  it('buckets an update from earlier today as today', () => {
    expect(bucketFor(isoDaysAgo(0, 3), NOW)).toBe('today');
  });

  it('buckets an update from the calendar day before as yesterday', () => {
    expect(bucketFor(isoDaysAgo(1), NOW)).toBe('yesterday');
  });

  it('buckets 2-7 calendar days back as week', () => {
    expect(bucketFor(isoDaysAgo(2), NOW)).toBe('week');
    expect(bucketFor(isoDaysAgo(7), NOW)).toBe('week');
  });

  it('buckets anything older than 7 days as older', () => {
    expect(bucketFor(isoDaysAgo(8), NOW)).toBe('older');
    expect(bucketFor(isoDaysAgo(90), NOW)).toBe('older');
  });

  it('buckets by calendar day, not a rolling 24h window', () => {
    // Late the calendar day before is still "yesterday" by calendar day,
    // even though it can be under 24h before `now`.
    const lateYesterday = new Date(
      NOW.getFullYear(),
      NOW.getMonth(),
      NOW.getDate() - 1,
      23,
      0,
      0,
    ).toISOString();
    expect(bucketFor(lateYesterday, NOW)).toBe('yesterday');
  });
});

describe('formatRelativeTime', () => {
  it('shows "now" for anything under a minute old', () => {
    expect(formatRelativeTime(NOW.toISOString(), NOW)).toBe('now');
  });

  it('shows compact minutes under an hour', () => {
    const then = new Date(NOW.getTime() - 35 * 60000).toISOString();
    expect(formatRelativeTime(then, NOW)).toBe('35m');
  });

  it('shows compact hours under a day', () => {
    const then = new Date(NOW.getTime() - 2 * 3600000).toISOString();
    expect(formatRelativeTime(then, NOW)).toBe('2h');
  });

  it('shows compact days under a week', () => {
    const then = new Date(NOW.getTime() - 3 * 86400000).toISOString();
    expect(formatRelativeTime(then, NOW)).toBe('3d');
  });

  it('falls back to an absolute date past a week', () => {
    const then = new Date(NOW.getTime() - 20 * 86400000).toISOString();
    expect(formatRelativeTime(then, NOW)).not.toMatch(/[dhm]$/);
  });

  it('clamps future timestamps (clock skew) to "now" instead of a negative duration', () => {
    const future = new Date(NOW.getTime() + 60000).toISOString();
    expect(formatRelativeTime(future, NOW)).toBe('now');
  });
});

describe('createSession', () => {
  it('creates a session with defaults and no messages', () => {
    const { session: created } = createSession([], NOW);
    expect(created.title).toBe(DEFAULT_SESSION_TITLE);
    expect(created.pinned).toBe(false);
    expect(created.order).toBe(0);
    expect(created.claudeSessionId).toBeNull();
    expect(created.messages).toEqual([]);
    expect(created.createdAt).toBe(NOW.toISOString());
  });

  it('places the new session first and bumps existing today/unpinned siblings down', () => {
    const existing = [
      session({ id: 'a', order: 0 }),
      session({ id: 'b', order: 1 }),
    ];
    const { sessions: next, session: created } = createSession(existing, NOW);

    expect(next[0].id).toBe(created.id);
    expect(next.find((s) => s.id === 'a')?.order).toBe(1);
    expect(next.find((s) => s.id === 'b')?.order).toBe(2);
  });

  it("does not bump siblings outside today's unpinned group", () => {
    const pinnedSibling = session({ id: 'p', pinned: true, order: 0 });
    const olderSibling = session({
      id: 'o',
      order: 0,
      updatedAt: isoDaysAgo(3),
    });
    const { sessions: next } = createSession(
      [pinnedSibling, olderSibling],
      NOW,
    );

    expect(next.find((s) => s.id === 'p')?.order).toBe(0);
    expect(next.find((s) => s.id === 'o')?.order).toBe(0);
  });

  it('generates unique ids across repeated calls', () => {
    const { session: first } = createSession([], NOW);
    const { session: second } = createSession([first], NOW);
    expect(first.id).not.toBe(second.id);
  });
});

describe('renameSession', () => {
  it('renames the matching session', () => {
    const next = renameSession(
      [session({ id: 's1', title: 'Old' })],
      's1',
      'New title',
    );
    expect(next.find((s) => s.id === 's1')?.title).toBe('New title');
  });

  it('trims whitespace', () => {
    const next = renameSession([session({ id: 's1' })], 's1', '  Trimmed  ');
    expect(next.find((s) => s.id === 's1')?.title).toBe('Trimmed');
  });

  it('is a no-op for a blank/whitespace-only title, matching the mockup', () => {
    const original = session({ id: 's1', title: 'Keep me' });
    const next = renameSession([original], 's1', '   ');
    expect(next.find((s) => s.id === 's1')?.title).toBe('Keep me');
  });

  it('truncates an overlong title', () => {
    const longTitle = 'x'.repeat(200);
    const next = renameSession([session({ id: 's1' })], 's1', longTitle);
    expect(next.find((s) => s.id === 's1')?.title.length).toBeLessThanOrEqual(
      60,
    );
  });

  it('leaves other sessions untouched', () => {
    const other = session({ id: 'other', title: 'Untouched' });
    const next = renameSession([session({ id: 's1' }), other], 's1', 'New');
    expect(next.find((s) => s.id === 'other')?.title).toBe('Untouched');
  });
});

describe('togglePinSession', () => {
  it('pins an unpinned session', () => {
    const next = togglePinSession(
      [session({ id: 's1', pinned: false })],
      's1',
      NOW,
    );
    expect(next.find((s) => s.id === 's1')?.pinned).toBe(true);
  });

  it('unpins a pinned session', () => {
    const next = togglePinSession(
      [session({ id: 's1', pinned: true })],
      's1',
      NOW,
    );
    expect(next.find((s) => s.id === 's1')?.pinned).toBe(false);
  });

  it('appends to the bottom of the destination group', () => {
    const pinnedA = session({ id: 'a', pinned: true, order: 0 });
    const pinnedB = session({ id: 'b', pinned: true, order: 1 });
    const toPin = session({ id: 'c', pinned: false, order: 0 });
    const next = togglePinSession([pinnedA, pinnedB, toPin], 'c', NOW);
    expect(next.find((s) => s.id === 'c')?.order).toBe(2);
  });

  it('unpinning places the session at the bottom of its current recency bucket, not order 0', () => {
    const otherToday = session({ id: 'other', pinned: false, order: 0 });
    const toUnpin = session({
      id: 'p',
      pinned: true,
      order: 0,
      updatedAt: NOW.toISOString(),
    });
    const next = togglePinSession([otherToday, toUnpin], 'p', NOW);
    expect(next.find((s) => s.id === 'p')?.order).toBe(1);
  });

  it('is a no-op for an unknown id', () => {
    const original = [session({ id: 's1' })];
    expect(togglePinSession(original, 'missing', NOW)).toEqual(original);
  });
});

describe('deleteSession', () => {
  it('removes the matching session and leaves the rest', () => {
    const next = deleteSession(
      [session({ id: 'a' }), session({ id: 'b' })],
      'a',
    );
    expect(next.map((s) => s.id)).toEqual(['b']);
  });

  it('is a no-op for an unknown id', () => {
    const original = [session({ id: 'a' })];
    expect(deleteSession(original, 'missing')).toEqual(original);
  });
});

describe('reorderSessionsWithinGroup', () => {
  it('moves a session to a new position within its group', () => {
    const a = session({ id: 'a', order: 0 });
    const b = session({ id: 'b', order: 1 });
    const c = session({ id: 'c', order: 2 });
    const next = reorderSessionsWithinGroup([a, b, c], 'a', 'c', 'today', NOW);

    const byOrder = [...next]
      .sort((x, y) => x.order - y.order)
      .map((s) => s.id);
    expect(byOrder).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when dragged onto itself', () => {
    const original = [
      session({ id: 'a', order: 0 }),
      session({ id: 'b', order: 1 }),
    ];
    expect(
      reorderSessionsWithinGroup(original, 'a', 'a', 'today', NOW),
    ).toEqual(original);
  });

  it('is a no-op across different groups (pinned vs. unpinned)', () => {
    const pinned = session({ id: 'p', pinned: true, order: 0 });
    const unpinned = session({ id: 'u', pinned: false, order: 0 });
    const next = reorderSessionsWithinGroup(
      [pinned, unpinned],
      'p',
      'u',
      'today',
      NOW,
    );
    // Dragging a pinned row onto an unpinned target under the 'today' group
    // resolves no source in that group, so nothing changes.
    expect(next).toEqual([pinned, unpinned]);
  });

  it('is a no-op across different recency buckets', () => {
    const todaySession = session({
      id: 't',
      order: 0,
      updatedAt: NOW.toISOString(),
    });
    const weekSession = session({
      id: 'w',
      order: 0,
      updatedAt: isoDaysAgo(3),
    });
    const next = reorderSessionsWithinGroup(
      [todaySession, weekSession],
      't',
      'w',
      'today',
      NOW,
    );
    expect(next).toEqual([todaySession, weekSession]);
  });

  it('does not disturb sessions outside the reordered group', () => {
    const a = session({ id: 'a', order: 0 });
    const b = session({ id: 'b', order: 1 });
    const outside = session({ id: 'outside', pinned: true, order: 5 });
    const next = reorderSessionsWithinGroup(
      [a, b, outside],
      'a',
      'b',
      'today',
      NOW,
    );
    expect(next.find((s) => s.id === 'outside')?.order).toBe(5);
  });
});

describe('appendMessage', () => {
  it('appends a message and bumps updatedAt', () => {
    const base = session({ id: 's1', updatedAt: isoDaysAgo(3) });
    const next = appendMessage(
      [base],
      's1',
      { role: 'user', content: 'hello' },
      NOW,
    );
    const updated = next.find((s) => s.id === 's1');
    expect(updated?.messages).toHaveLength(1);
    expect(updated?.messages[0]).toMatchObject({
      role: 'user',
      content: 'hello',
    });
    expect(updated?.updatedAt).toBe(NOW.toISOString());
  });

  it('auto-titles from the first user message while the title is still the default', () => {
    const base = session({ id: 's1', title: DEFAULT_SESSION_TITLE });
    const next = appendMessage(
      [base],
      's1',
      { role: 'user', content: 'Can we ship the search revamp?' },
      NOW,
    );
    expect(next.find((s) => s.id === 's1')?.title).toBe(
      'Can we ship the search revamp?',
    );
  });

  it('does not auto-title from an assistant message', () => {
    const base = session({ id: 's1', title: DEFAULT_SESSION_TITLE });
    const next = appendMessage(
      [base],
      's1',
      { role: 'assistant', content: 'Here is my answer' },
      NOW,
    );
    expect(next.find((s) => s.id === 's1')?.title).toBe(DEFAULT_SESSION_TITLE);
  });

  it('does not overwrite a title the user already set', () => {
    const base = session({ id: 's1', title: 'My custom title' });
    const next = appendMessage(
      [base],
      's1',
      { role: 'user', content: 'second message' },
      NOW,
    );
    expect(next.find((s) => s.id === 's1')?.title).toBe('My custom title');
  });

  it('does not auto-title once the session already has messages', () => {
    const base = session({
      id: 's1',
      title: DEFAULT_SESSION_TITLE,
      messages: [
        {
          id: 'm0',
          role: 'assistant',
          content: 'prior reply',
          createdAt: isoDaysAgo(1),
        },
      ],
    });
    const next = appendMessage(
      [base],
      's1',
      { role: 'user', content: 'follow up' },
      NOW,
    );
    expect(next.find((s) => s.id === 's1')?.title).toBe(DEFAULT_SESSION_TITLE);
  });

  it('assigns each message a unique id', () => {
    let sessions = [session({ id: 's1' })];
    sessions = appendMessage(
      sessions,
      's1',
      { role: 'user', content: 'one' },
      NOW,
    );
    sessions = appendMessage(
      sessions,
      's1',
      { role: 'assistant', content: 'two' },
      NOW,
    );
    const [m1, m2] = sessions[0].messages;
    expect(m1.id).not.toBe(m2.id);
  });
});

describe('setClaudeSessionId', () => {
  it('sets the claudeSessionId on the matching session', () => {
    const next = setClaudeSessionId(
      [session({ id: 's1' })],
      's1',
      'claude-abc',
    );
    expect(next.find((s) => s.id === 's1')?.claudeSessionId).toBe('claude-abc');
  });

  it('can clear it back to null', () => {
    const next = setClaudeSessionId(
      [session({ id: 's1', claudeSessionId: 'claude-abc' })],
      's1',
      null,
    );
    expect(next.find((s) => s.id === 's1')?.claudeSessionId).toBeNull();
  });
});

describe('lastMessagePreview', () => {
  it('returns null when there are no messages', () => {
    expect(lastMessagePreview(session({ messages: [] }))).toBeNull();
  });

  it('returns the last message, single-lined', () => {
    const withMessages = session({
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'first',
          createdAt: NOW.toISOString(),
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'line one\nline two',
          createdAt: NOW.toISOString(),
        },
      ],
    });
    expect(lastMessagePreview(withMessages)).toBe('line one line two');
  });
});

describe('groupSessions', () => {
  it('produces a Pinned group first, then recency buckets in order, and omits empty groups', () => {
    const pinned = session({ id: 'p', pinned: true, order: 0 });
    const today = session({ id: 't', order: 0, updatedAt: NOW.toISOString() });
    const older = session({ id: 'o', order: 0, updatedAt: isoDaysAgo(10) });

    const groups = groupSessions([pinned, today, older], NOW);

    expect(groups.map((g) => g.key)).toEqual(['pinned', 'today', 'older']);
  });

  it('omits the Pinned group entirely when nothing is pinned', () => {
    const groups = groupSessions(
      [session({ id: 't', updatedAt: NOW.toISOString() })],
      NOW,
    );
    expect(groups.some((g) => g.key === 'pinned')).toBe(false);
  });

  it('sorts sessions within each group by their manual order', () => {
    const a = session({ id: 'a', order: 2, updatedAt: NOW.toISOString() });
    const b = session({ id: 'b', order: 0, updatedAt: NOW.toISOString() });
    const c = session({ id: 'c', order: 1, updatedAt: NOW.toISOString() });

    const groups = groupSessions([a, b, c], NOW);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('returns no groups for an empty session list', () => {
    expect(groupSessions([], NOW)).toEqual([]);
  });
});

describe('loadSessions / saveSessions', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty array when nothing has been saved yet', () => {
    expect(loadSessions()).toEqual([]);
  });

  it('round-trips sessions through localStorage', () => {
    const sessions = [session({ id: 's1' })];
    saveSessions(sessions);
    expect(loadSessions()).toEqual(sessions);
  });

  it('falls back to an empty array for corrupt/malformed stored JSON', () => {
    localStorage.setItem('waypoint:copilot-sessions', '{not valid json');
    expect(loadSessions()).toEqual([]);
  });

  it('falls back to an empty array when the stored value is not an array', () => {
    localStorage.setItem(
      'waypoint:copilot-sessions',
      JSON.stringify({ not: 'an array' }),
    );
    expect(loadSessions()).toEqual([]);
  });
});
