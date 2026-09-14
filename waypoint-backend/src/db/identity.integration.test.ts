import 'dotenv/config';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import postgres from 'postgres';

// AT7 (ROAD-142): the identity/membership split is a migration-only
// change, and the one thing it *changes* about existing behavior — a
// person may belong to two workspaces on one instance — is a constraint
// only the real database can prove. The old `members.email` global unique
// rejected the second membership outright; a mocked db would happily
// insert it either way. This file exists to catch that constraint being
// silently reverted (e.g. by a regenerated migration from a stale schema).
//
// Skipped, not failed, without a reachable database — same rule as
// proposals.service.integration.test.ts.
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

describe.skipIf(!REAL_DB)('identity split against real Postgres (AT7)', () => {
  let db: typeof import('./client.js')['db'];
  let schema: typeof import('./schema/index.js');
  let eq: typeof import('drizzle-orm')['eq'];
  let inArray: typeof import('drizzle-orm')['inArray'];

  const WS = ['at7-ws-a', 'at7-ws-b'];
  const MEMBERS = ['at7-mem-a', 'at7-mem-b'];
  const USER = 'at7-user-1';
  const EMAIL = 'jordan.at7@example.test';

  beforeAll(async () => {
    ({ db } = await import('./client.js'));
    schema = await import('./schema/index.js');
    ({ eq, inArray } = await import('drizzle-orm'));
  });

  afterEach(async () => {
    // Order matters: members → workspaces (FK), sessions → users (FK).
    await db.delete(schema.members).where(inArray(schema.members.id, MEMBERS));
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, WS));
    await db.delete(schema.users).where(eq(schema.users.id, USER));
  });

  async function twoWorkspaces() {
    await db.insert(schema.workspaces).values(
      WS.map((id) => ({
        id,
        name: id,
        slug: id,
        companySize: '2-10',
        timezone: 'UTC',
      })),
    );
  }

  it('lets one person hold memberships in two workspaces (email unique per workspace, not globally)', async () => {
    await twoWorkspaces();
    await db.insert(schema.members).values(
      WS.map((workspaceId, i) => ({
        id: MEMBERS[i],
        workspaceId,
        fullName: 'Jordan Reyes',
        displayName: 'Jordan',
        email: EMAIL,
        avatarColor: '#000000',
      })),
    );
    const rows = await db.select().from(schema.members).where(eq(schema.members.email, EMAIL));
    expect(rows.map((r) => r.workspaceId).sort()).toEqual([...WS].sort());
  });

  it('still rejects the same email twice inside one workspace', async () => {
    await twoWorkspaces();
    const base = {
      workspaceId: WS[0],
      fullName: 'Jordan Reyes',
      displayName: 'Jordan',
      email: EMAIL,
      avatarColor: '#000000',
    };
    await db.insert(schema.members).values({ id: MEMBERS[0], ...base });
    // Drizzle wraps the driver error; the Postgres error is on `cause`.
    // Asserting the constraint *name* is the point: it proves the
    // composite unique replaced the global one, not just that something
    // unique fired.
    await expect(db.insert(schema.members).values({ id: MEMBERS[1], ...base })).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'members_workspace_id_email_unique' },
    });
  });

  it('a member may point at a users row, and Personal members may point at none', async () => {
    await twoWorkspaces();
    await db.insert(schema.users).values({ id: USER, email: EMAIL, fullName: 'Jordan Reyes' });
    await db.insert(schema.members).values([
      {
        id: MEMBERS[0],
        workspaceId: WS[0],
        fullName: 'Jordan Reyes',
        displayName: 'Jordan',
        email: EMAIL,
        avatarColor: '#000000',
        userId: USER,
      },
      {
        id: MEMBERS[1],
        workspaceId: WS[1],
        fullName: 'You',
        displayName: 'You',
        email: 'you@local.test',
        avatarColor: '#000000',
        // Personal's seeded row shape: never signed in, no users row.
        userId: null,
      },
    ]);
    const rows = await db
      .select({ id: schema.members.id, userId: schema.members.userId })
      .from(schema.members)
      .where(inArray(schema.members.id, MEMBERS));
    expect(new Map(rows.map((r) => [r.id, r.userId]))).toEqual(
      new Map([
        [MEMBERS[0], USER],
        [MEMBERS[1], null],
      ]),
    );
  });

  it('the seeded workspace is flagged Personal with the free 30-day history window', async () => {
    const [ws] = await db
      .select({ isPersonal: schema.workspaces.isPersonal, days: schema.workspaces.reviewHistoryDays })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, 'ws-1'));
    expect(ws).toEqual({ isPersonal: true, days: 30 });
  });
});
