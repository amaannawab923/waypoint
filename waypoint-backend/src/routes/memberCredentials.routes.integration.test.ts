import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import postgres from 'postgres';

// AT12 (ROAD-147). GET/PUT/DELETE /me/jira-credential against real
// Postgres — self-service only (currentMemberId()-scoped, no id param),
// so the property worth proving live isn't a cross-tenant :id guard (there
// is none to bypass) but that the underlying seal/open AAD binding
// actually stops one member's stored ciphertext from opening under
// another member's identity, and that the raw apiToken is never echoed
// back over HTTP on GET or PUT.
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

describe.skipIf(!REAL_DB)('per-member Jira credential storage against real Postgres (AT12)', () => {
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: typeof import('drizzle-orm')['eq'];
  let issueSession: typeof import('../auth/sessions.js')['issueSession'];
  let app: import('express').Express;
  let runWithIdentity: typeof import('../lib/requestContext.js')['runWithIdentity'];
  let credentials: typeof import('../services/memberCredentials.service.js');

  const stamp = Date.now();
  const A = {
    workspaceId: `ws-at12cred-a-${stamp}`,
    userId: `user-at12cred-a-${stamp}`,
    memberId: `mem-at12cred-a-${stamp}`,
    token: '',
  };
  const B = {
    workspaceId: `ws-at12cred-b-${stamp}`,
    userId: `user-at12cred-b-${stamp}`,
    memberId: `mem-at12cred-b-${stamp}`,
    token: '',
  };

  function asA() {
    return { Authorization: `Bearer ${A.token}`, 'X-Waypoint-Workspace-Id': A.workspaceId };
  }
  function asB() {
    return { Authorization: `Bearer ${B.token}`, 'X-Waypoint-Workspace-Id': B.workspaceId };
  }

  async function seedTenant(t: typeof A | typeof B) {
    await db.insert(schema.workspaces).values({
      id: t.workspaceId,
      name: `AT12 cred tenant ${t.workspaceId}`,
      slug: t.workspaceId,
      companySize: '2-10',
      timezone: 'UTC',
    });
    await db.insert(schema.users).values({ id: t.userId, email: `${t.userId}@example.test`, fullName: 'AT12 Cred User', authMethod: 'email' });
    await db.insert(schema.members).values({
      id: t.memberId,
      workspaceId: t.workspaceId,
      userId: t.userId,
      fullName: 'AT12 Cred User',
      displayName: 'AT12 Cred User',
      email: `${t.memberId}@example.test`,
      avatarColor: '#000000',
      role: 'admin',
      authMethod: 'email',
    });
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    schema = await import('../db/schema/index.js');
    ({ eq } = await import('drizzle-orm'));
    ({ issueSession } = await import('../auth/sessions.js'));
    ({ runWithIdentity } = await import('../lib/requestContext.js'));
    credentials = await import('../services/memberCredentials.service.js');
    const { createApp } = await import('../app.js');
    app = createApp();

    // Seeded once, not per-test: each test manages its own credential
    // state (set/clear) rather than needing a bare tenant every time, and
    // seeding real workspace/user/member rows per-test would collide on
    // this file's fixed stamp-based ids.
    await seedTenant(A);
    await seedTenant(B);
    A.token = (await issueSession(A.userId)).token;
    B.token = (await issueSession(B.userId)).token;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, A.userId));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, B.userId));
    await db.delete(schema.users).where(eq(schema.users.id, A.userId));
    await db.delete(schema.users).where(eq(schema.users.id, B.userId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, A.workspaceId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, B.workspaceId));
  });

  it('GET starts disconnected, PUT round-trips status only (never the raw token), DELETE clears it', async () => {
    const before = await request(app).get('/me/jira-credential').set(asA());
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ connected: false });

    const put = await request(app)
      .put('/me/jira-credential')
      .set(asA())
      .send({ site: 'fairweather.atlassian.net', email: 'amaan@fairweather.test', apiToken: 'super-secret-token' });
    expect(put.status).toBe(200);
    expect(put.body.connected).toBe(true);
    expect(put.body.site).toBe('fairweather.atlassian.net');
    expect(put.body.email).toBe('amaan@fairweather.test');
    expect(JSON.stringify(put.body)).not.toContain('super-secret-token');

    const after = await request(app).get('/me/jira-credential').set(asA());
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ connected: true, site: 'fairweather.atlassian.net', email: 'amaan@fairweather.test' });
    expect(JSON.stringify(after.body)).not.toContain('super-secret-token');

    // Stored encrypted, not plaintext — the raw token never appears as a
    // Postgres column value either.
    const [row] = await db.select().from(schema.members).where(eq(schema.members.id, A.memberId));
    expect(row?.jiraCredentialEncrypted).toBeTruthy();
    expect(row?.jiraCredentialEncrypted).not.toContain('super-secret-token');

    const del = await request(app).delete('/me/jira-credential').set(asA());
    expect(del.status).toBe(204);
    const cleared = await request(app).get('/me/jira-credential').set(asA());
    expect(cleared.body).toEqual({ connected: false });
  });

  it('rejects a non-Jira-Cloud-shaped site before it ever reaches storage', async () => {
    const res = await request(app)
      .put('/me/jira-credential')
      .set(asA())
      .send({ site: 'not a hostname', email: 'amaan@fairweather.test', apiToken: 'x' });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(schema.members).where(eq(schema.members.id, A.memberId));
    expect(row?.jiraCredentialEncrypted).toBeNull();
  });

  it("B setting their own credential never touches or reveals A's", async () => {
    await request(app)
      .put('/me/jira-credential')
      .set(asA())
      .send({ site: 'a-site.atlassian.net', email: 'a@x.test', apiToken: 'a-token' });
    await request(app)
      .put('/me/jira-credential')
      .set(asB())
      .send({ site: 'b-site.atlassian.net', email: 'b@x.test', apiToken: 'b-token' });

    const aStatus = await request(app).get('/me/jira-credential').set(asA());
    expect(aStatus.body.site).toBe('a-site.atlassian.net');
    const bStatus = await request(app).get('/me/jira-credential').set(asB());
    expect(bStatus.body.site).toBe('b-site.atlassian.net');
  });

  it("SECURITY: A's sealed ciphertext does not open under B's identity — proves AAD binding, not just separate rows", async () => {
    await request(app)
      .put('/me/jira-credential')
      .set(asA())
      .send({ site: 'a-site.atlassian.net', email: 'a@x.test', apiToken: 'a-secret' });
    const [aRow] = await db.select().from(schema.members).where(eq(schema.members.id, A.memberId));
    expect(aRow?.jiraCredentialEncrypted).toBeTruthy();

    // Splice A's ciphertext into B's row directly (what a compromised
    // read path or a raw SQL copy/paste mistake would look like) and try
    // to read it as B — this can only succeed if the seal is bound to the
    // row it's stored in, not just kept apart by normal query scoping.
    await db.update(schema.members).set({ jiraCredentialEncrypted: aRow!.jiraCredentialEncrypted }).where(eq(schema.members.id, B.memberId));
    const asBStatus = await runWithIdentity({ userId: B.userId, memberId: B.memberId, workspaceId: B.workspaceId, role: 'admin' }, () =>
      credentials.getMyJiraCredentialStatus(),
    );
    expect(asBStatus.connected).toBe(false);
    expect(asBStatus.needsReconnect).toBe(true);
  });
});
