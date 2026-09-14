import 'dotenv/config';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';

// AT8 (ROAD-143): completeSetup is one transaction — an unverified admin
// users row plus the singleton instance_settings row — and its "already
// set up" refusal rests on that row's primary key. Only the real
// database can prove the pair lands together and that a second setup
// is refused. Skipped, not failed, without a reachable database.
//
// The shared dev database may or may not already hold the 'instance'
// row (the seed doesn't create one; a self-hosted run would). The suite
// saves whatever is there, runs against a clean slate, and restores it.
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

const ENV_ALL = { GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: 'secret' };
const INPUT = {
  instanceName: 'AT8 test instance',
  signupMode: 'invite_only' as const,
  admin: { email: 'at8-operator@example.test', fullName: 'AT8 Operator' },
};

describe.skipIf(!REAL_DB)('instance setup against real Postgres (AT8)', () => {
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let service: typeof import('./instance.service.js');
  let eq: typeof import('drizzle-orm')['eq'];
  let saved: typeof schema.instanceSettings.$inferSelect | undefined;

  async function clean() {
    await db.delete(schema.instanceSettings).where(eq(schema.instanceSettings.id, service.INSTANCE_ROW_ID));
    await db.delete(schema.users).where(eq(schema.users.email, INPUT.admin.email));
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    schema = await import('../db/schema/index.js');
    service = await import('./instance.service.js');
    ({ eq } = await import('drizzle-orm'));
    [saved] = await db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, service.INSTANCE_ROW_ID));
  });

  beforeEach(clean);

  afterAll(async () => {
    await clean();
    if (saved) await db.insert(schema.instanceSettings).values(saved);
  });

  it('reports setupRequired until the row exists, then not', async () => {
    expect((await service.getSetupStatus(ENV_ALL)).setupRequired).toBe(true);
    await service.completeSetup(INPUT, ENV_ALL);
    const after = await service.getSetupStatus(ENV_ALL);
    expect(after).toMatchObject({ setupRequired: false, instanceName: INPUT.instanceName, signupMode: 'invite_only' });
  });

  it('creates the admin unverified, as instance admin, in the same transaction as the settings row', async () => {
    const { instance, admin } = await service.completeSetup(INPUT, ENV_ALL);
    expect(instance).toMatchObject({ id: 'instance', instanceName: INPUT.instanceName, signupMode: 'invite_only' });
    expect(instance.setupCompletedAt).toBeInstanceOf(Date);
    expect(admin).toMatchObject({ email: INPUT.admin.email, isInstanceAdmin: true, emailVerifiedAt: null });
  });

  it('refuses a second setup with a conflict and leaves the first admin alone', async () => {
    await service.completeSetup(INPUT, ENV_ALL);
    await expect(
      service.completeSetup({ ...INPUT, admin: { email: 'at8-operator@example.test', fullName: 'Impostor' } }, ENV_ALL),
    ).rejects.toMatchObject({ name: 'ConflictError' });
    const admins = await db.select().from(schema.users).where(eq(schema.users.email, INPUT.admin.email));
    expect(admins).toHaveLength(1);
    expect(admins[0].fullName).toBe('AT8 Operator');
  });

  it('refuses to produce an instance with no sign-in method configured, writing nothing', async () => {
    await expect(service.completeSetup(INPUT, {})).rejects.toMatchObject({ name: 'ValidationError' });
    expect((await service.getSetupStatus({})).setupRequired).toBe(true);
    expect(await db.select().from(schema.users).where(eq(schema.users.email, INPUT.admin.email))).toHaveLength(0);
  });

  it('getInstance and updateInstance work once set up, and counts are real', async () => {
    await service.completeSetup(INPUT, ENV_ALL);
    const before = await service.getInstance();
    expect(before.counts.users).toBeGreaterThanOrEqual(1);
    expect(before.counts.workspaces).toBeGreaterThanOrEqual(1);
    const updated = await service.updateInstance({ signupMode: 'open' });
    expect(updated.signupMode).toBe('open');
    expect((await service.getInstance()).signupMode).toBe('open');
  });
});
