import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

// The notifications foundation: paging, tabs, the unread count, and
// read/unread/read-all, against real Postgres. Paging needs a real database
// because the property that matters (no row skipped or repeated when rows
// share a timestamp) lives in the timestamptz comparison, not in JS.
//
// Same skip-when-unreachable shape as the other *.integration.test.ts files.
async function databaseReachable(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const probe = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 3 });
  }
}

const REAL_DB = await databaseReachable();

describe.skipIf(!REAL_DB)('notifications service against real Postgres', () => {
  let svc: typeof import('./notifications.service.js');
  let db: (typeof import('../db/client.js'))['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: (typeof import('drizzle-orm'))['eq'];
  let runWithIdentity: (typeof import('../lib/requestContext.js'))['runWithIdentity'];

  const stamp = Date.now();
  const workspaceId = `ws-itest-notif-${stamp}`;
  const ME = `mem-itest-notif-me-${stamp}`;
  const OTHER = `mem-itest-notif-other-${stamp}`;

  const as = <T>(memberId: string, fn: () => Promise<T>) =>
    runWithIdentity({ userId: 'user-itest', memberId, workspaceId, role: 'admin' }, fn);

  // Five rows for ME. Three share one exact timestamp, which is what used to
  // make millisecond cursors skip rows.
  const T0 = new Date('2026-09-01T10:00:00.123456Z');
  const same = new Date('2026-09-02T10:00:00.000Z');
  const rows = [
    { id: `nt-a-${stamp}`, kind: 'mention' as const, updatedAt: T0 },
    { id: `nt-b-${stamp}`, kind: 'agent_blocked' as const, updatedAt: same },
    { id: `nt-c-${stamp}`, kind: 'mention' as const, updatedAt: same },
    { id: `nt-d-${stamp}`, kind: 'reply' as const, updatedAt: same },
    { id: `nt-e-${stamp}`, kind: 'assigned' as const, updatedAt: new Date('2026-09-03T10:00:00Z'), read: true },
  ];

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    svc = await import('./notifications.service.js');
    schema = await import('../db/schema/index.js');
    ({ eq } = await import('drizzle-orm'));
    ({ runWithIdentity } = await import('../lib/requestContext.js'));

    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: 'notifications itest',
      slug: workspaceId,
      companySize: '2-10',
      timezone: 'UTC',
    });
    await db.insert(schema.members).values(
      [ME, OTHER].map((id) => ({
        id,
        workspaceId,
        fullName: `${id} Tester`,
        displayName: id,
        email: `${id}@example.test`,
        avatarColor: '#000000',
      })),
    );
    await db.insert(schema.notifications).values([
      ...rows.map((r) => ({
        id: r.id,
        recipientId: ME,
        actorId: OTHER,
        kind: r.kind,
        createdAt: r.updatedAt,
        updatedAt: r.updatedAt,
        readAt: r.read ? r.updatedAt : null,
      })),
      // Someone else's, which ME must never see or touch.
      { id: `nt-x-${stamp}`, recipientId: OTHER, actorId: ME, kind: 'mention' as const },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  });

  async function readAtOf(id: string) {
    const [r] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, id));
    return r?.readAt ?? null;
  }

  it('pages newest-first through rows that share a timestamp, never skipping or repeating one', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await as(ME, () => svc.listNotifications({ limit: 1, cursor }));
      seen.push(...page.items.map((n) => n.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([
      `nt-e-${stamp}`,
      // Same updated_at: ordered by id DESC.
      `nt-d-${stamp}`,
      `nt-c-${stamp}`,
      `nt-b-${stamp}`,
      `nt-a-${stamp}`,
    ]);
  });

  it('returns only the caller’s rows, with a derived `read` and the unread count', async () => {
    const page = await as(ME, () => svc.listNotifications());
    expect(page.items.map((n) => n.recipientId)).toEqual(Array(5).fill(ME));
    expect(page.items.find((n) => n.id === `nt-e-${stamp}`)?.read).toBe(true);
    expect(page.items.find((n) => n.id === `nt-a-${stamp}`)?.read).toBe(false);
    expect(page.unreadCount).toBe(4);
    expect(await as(ME, () => svc.countUnreadNotifications())).toBe(4);
  });

  it('filters by tab and by unread', async () => {
    const mentions = await as(ME, () => svc.listNotifications({ tab: 'mentions' }));
    expect(mentions.items.map((n) => n.kind).sort()).toEqual(['mention', 'mention', 'reply']);
    const sessions = await as(ME, () => svc.listNotifications({ tab: 'sessions' }));
    expect(sessions.items.map((n) => n.id)).toEqual([`nt-b-${stamp}`]);
    const unread = await as(ME, () => svc.listNotifications({ unreadOnly: true }));
    expect(unread.items.map((n) => n.id)).not.toContain(`nt-e-${stamp}`);
  });

  it('rejects a malformed cursor instead of returning everything', async () => {
    await expect(as(ME, () => svc.listNotifications({ cursor: 'not-a-cursor' }))).rejects.toThrow(/invalid cursor/);
  });

  it('marks one read and unread again, only for its recipient', async () => {
    const id = `nt-a-${stamp}`;
    await as(OTHER, () => svc.markNotificationRead(id));
    expect(await readAtOf(id)).toBeNull();
    await as(ME, () => svc.markNotificationRead(id));
    expect(await readAtOf(id)).not.toBeNull();
    await as(OTHER, () => svc.markNotificationUnread(id));
    expect(await readAtOf(id)).not.toBeNull();
    await as(ME, () => svc.markNotificationUnread(id));
    expect(await readAtOf(id)).toBeNull();
  });

  it('read-all clears only what the caller has loaded, only in the tab, only their own', async () => {
    // The caller loaded down to nt-c (inclusive); nt-b and nt-a are older and
    // unloaded... but "before" is an upper bound on NEWNESS: everything at or
    // older than the newest loaded row is fair game, a newer arrival is not.
    const first = await as(ME, () => svc.listNotifications({ tab: 'mentions', limit: 1 }));
    const newestLoaded = first.items[0]!;
    expect(newestLoaded.id).toBe(`nt-d-${stamp}`);

    // A mention that lands while the list is open, newer than what was loaded.
    const late = `nt-late-${stamp}`;
    await db.insert(schema.notifications).values({
      id: late,
      recipientId: ME,
      actorId: OTHER,
      kind: 'mention',
      updatedAt: new Date('2026-09-04T10:00:00Z'),
    });

    const res = await as(ME, () => svc.markAllNotificationsRead({ tab: 'mentions', before: newestLoaded.cursor }));
    expect(res.updated).toBe(3); // nt-d, nt-c, nt-a
    expect(await readAtOf(late)).toBeNull(); // arrived after: still unread
    expect(await readAtOf(`nt-b-${stamp}`)).toBeNull(); // sessions tab: untouched
    expect(await readAtOf(`nt-x-${stamp}`)).toBeNull(); // someone else's: untouched
  });
});
