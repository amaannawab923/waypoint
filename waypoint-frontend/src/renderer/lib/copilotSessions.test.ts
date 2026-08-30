import {
  bucketFor,
  formatRelativeTime,
  groupSessions,
  lastMessagePreview,
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
