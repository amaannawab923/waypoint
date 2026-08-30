import {
  loadMeta,
  saveMeta,
  getMeta,
  removeMeta,
  togglePin,
  reorderWithinGroup,
  type CopilotSessionMetaMap,
} from './copilotSessionMeta';
import type { CopilotSession } from './copilotSessions';

const NOW = new Date(2026, 7, 26, 12, 0, 0);

function isoDaysAgo(days: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function session(
  id: string,
  overrides: Partial<CopilotSession> = {},
): CopilotSession {
  return {
    id,
    title: 'A session',
    pinned: false,
    order: 0,
    claudeSessionId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    messages: [],
    ...overrides,
  };
}

describe('getMeta', () => {
  it('defaults to unpinned, order 0 for an id not yet in the map', () => {
    expect(getMeta({}, 's1')).toEqual({ pinned: false, order: 0 });
  });

  it('returns the stored entry when present', () => {
    const meta: CopilotSessionMetaMap = { s1: { pinned: true, order: 3 } };
    expect(getMeta(meta, 's1')).toEqual({ pinned: true, order: 3 });
  });
});

describe('removeMeta', () => {
  it('removes the entry for the given id', () => {
    const meta: CopilotSessionMetaMap = {
      s1: { pinned: true, order: 0 },
      s2: { pinned: false, order: 1 },
    };
    expect(removeMeta(meta, 's1')).toEqual({ s2: { pinned: false, order: 1 } });
  });

  it('is a no-op for an id not present', () => {
    const meta: CopilotSessionMetaMap = { s1: { pinned: false, order: 0 } };
    expect(removeMeta(meta, 'missing')).toEqual(meta);
  });
});

describe('togglePin', () => {
  it('pins an unpinned session', () => {
    const sessions = [session('s1')];
    const next = togglePin({}, sessions, 's1', NOW);
    expect(getMeta(next, 's1').pinned).toBe(true);
  });

  it('unpins a pinned session', () => {
    const sessions = [session('s1', { pinned: true })];
    const next = togglePin(
      { s1: { pinned: true, order: 0 } },
      sessions,
      's1',
      NOW,
    );
    expect(getMeta(next, 's1').pinned).toBe(false);
  });

  it('appends to the bottom of the destination group', () => {
    const sessions = [
      session('a', { pinned: true }),
      session('b', { pinned: true }),
      session('c'),
    ];
    const meta: CopilotSessionMetaMap = {
      a: { pinned: true, order: 0 },
      b: { pinned: true, order: 1 },
      c: { pinned: false, order: 0 },
    };
    const next = togglePin(meta, sessions, 'c', NOW);
    expect(getMeta(next, 'c').order).toBe(2);
  });

  it('unpinning places the session at the bottom of its current recency bucket, not order 0', () => {
    const sessions = [session('other'), session('p', { pinned: true })];
    const meta: CopilotSessionMetaMap = {
      other: { pinned: false, order: 0 },
      p: { pinned: true, order: 0 },
    };
    const next = togglePin(meta, sessions, 'p', NOW);
    expect(getMeta(next, 'p').order).toBe(1);
  });

  it('is a no-op for an unknown id', () => {
    const sessions = [session('s1')];
    expect(togglePin({}, sessions, 'missing', NOW)).toEqual({});
  });
});

describe('reorderWithinGroup', () => {
  it('moves a session to a new position within its group', () => {
    const sessions = [session('a'), session('b'), session('c')];
    const meta: CopilotSessionMetaMap = {
      a: { pinned: false, order: 0 },
      b: { pinned: false, order: 1 },
      c: { pinned: false, order: 2 },
    };
    const next = reorderWithinGroup(meta, sessions, 'a', 'c', 'today', NOW);

    const byOrder = Object.entries(next)
      .sort(([, x], [, y]) => x.order - y.order)
      .map(([id]) => id);
    expect(byOrder).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when dragged onto itself', () => {
    const sessions = [session('a'), session('b')];
    const meta: CopilotSessionMetaMap = {
      a: { pinned: false, order: 0 },
      b: { pinned: false, order: 1 },
    };
    expect(reorderWithinGroup(meta, sessions, 'a', 'a', 'today', NOW)).toEqual(
      meta,
    );
  });

  it('is a no-op across different groups (pinned vs. unpinned)', () => {
    const sessions = [session('p', { pinned: true }), session('u')];
    const meta: CopilotSessionMetaMap = {
      p: { pinned: true, order: 0 },
      u: { pinned: false, order: 0 },
    };
    const next = reorderWithinGroup(meta, sessions, 'p', 'u', 'today', NOW);
    expect(next).toEqual(meta);
  });

  it('is a no-op across different recency buckets', () => {
    const sessions = [session('t'), session('w', { updatedAt: isoDaysAgo(3) })];
    const meta: CopilotSessionMetaMap = {
      t: { pinned: false, order: 0 },
      w: { pinned: false, order: 0 },
    };
    const next = reorderWithinGroup(meta, sessions, 't', 'w', 'today', NOW);
    expect(next).toEqual(meta);
  });

  it('does not disturb sessions outside the reordered group', () => {
    const sessions = [
      session('a'),
      session('b'),
      session('outside', { pinned: true }),
    ];
    const meta: CopilotSessionMetaMap = {
      a: { pinned: false, order: 0 },
      b: { pinned: false, order: 1 },
      outside: { pinned: true, order: 5 },
    };
    const next = reorderWithinGroup(meta, sessions, 'a', 'b', 'today', NOW);
    expect(getMeta(next, 'outside').order).toBe(5);
  });
});

describe('loadMeta / saveMeta', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty map when nothing has been saved yet', () => {
    expect(loadMeta()).toEqual({});
  });

  it('round-trips through localStorage', () => {
    const meta: CopilotSessionMetaMap = { s1: { pinned: true, order: 0 } };
    saveMeta(meta);
    expect(loadMeta()).toEqual(meta);
  });

  it('falls back to an empty map for corrupt/malformed stored JSON', () => {
    localStorage.setItem('waypoint:copilot-session-meta', '{not valid json');
    expect(loadMeta()).toEqual({});
  });

  it('falls back to an empty map when the stored value is an array', () => {
    // typeof [] === 'object' in JS — this is the one shape a bare
    // typeof-object check wouldn't catch, so it's asserted explicitly.
    localStorage.setItem(
      'waypoint:copilot-session-meta',
      JSON.stringify([1, 2, 3]),
    );
    expect(loadMeta()).toEqual({});
  });

  it('falls back to an empty map when the stored value is not an object', () => {
    localStorage.setItem(
      'waypoint:copilot-session-meta',
      JSON.stringify('a string'),
    );
    expect(loadMeta()).toEqual({});
  });
});
