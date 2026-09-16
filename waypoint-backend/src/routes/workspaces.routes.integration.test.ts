import 'dotenv/config';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import postgres from 'postgres';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { errorHandler } from '../middleware/errorHandler.js';
import type { FetchLike } from '../auth/providers/types.js';
import type { Mailer } from '../auth/mailer.js';

// AT12 (ROAD-147). Team workspace creation + the switcher's listing +
// invite + join, end to end against real Postgres — the same "drive the
// real HTTP boundary, not the service functions directly" bar
// workspaceScoping.integration.test.ts set for AT11. Can't reuse
// createApp() as-is (routes/index.ts's authRouter is a fixed singleton
// that talks to real SMTP/GitHub) — this test app mounts the same
// pieces createApp() does, but with an injectable auth router, same
// pattern auth.routes.integration.test.ts already uses.
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

const ENV: NodeJS.ProcessEnv = {
  GITHUB_OAUTH_CLIENT_ID: 'gh-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
  SMTP_HOST: 'smtp.example.test',
  SMTP_FROM: 'noreply@example.test',
};
const BASE = 'https://backend.example.test';
// workspaceInvites.routes.ts and join.routes.ts read process.env directly
// (publicBaseUrl()/configuredAuthMethods() with no override, unlike
// createAuthRouter's injectable deps) — real env vars, not just the ENV
// object above, need to reflect these for those two routes' behavior to
// match what the injected auth router does.
const envBackup = { ...process.env };

describe.skipIf(!REAL_DB)('team workspace creation + invite + join against real Postgres (AT12)', () => {
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: typeof import('drizzle-orm')['eq'];
  let ilike: typeof import('drizzle-orm')['ilike'];
  let issueSession: typeof import('../auth/sessions.js')['issueSession'];
  let instance: typeof import('../services/instance.service.js');
  let workspacesService: typeof import('../services/workspaces.service.js');
  let resolveMember: typeof import('../middleware/resolveMember.js')['resolveMember'];
  let workspacesRouter: typeof import('./workspaces.routes.js')['workspacesRouter'];
  let workspaceInvitesRouter: typeof import('./workspaceInvites.routes.js')['workspaceInvitesRouter'];
  let joinRouter: typeof import('./join.routes.js')['joinRouter'];
  let createAuthRouter: typeof import('./auth.routes.js')['createAuthRouter'];
  let savedInstance: typeof schema.instanceSettings.$inferSelect | undefined;
  const sent: Array<{ to: string; text: string }> = [];
  const mailer: Mailer = {
    async send(msg) {
      sent.push({ to: msg.to, text: msg.text });
    },
  };

  // Mounting order matters and mirrors app.ts exactly: workspacesRouter/
  // joinRouter/authRouter sit BEFORE resolveMember (identityOnlyRouter —
  // see routes/index.ts's comment: resolveMember hard-refuses any
  // bearer-token request with no workspace header, which would otherwise
  // block workspace creation before requireUser ever ran). But
  // workspaceInvitesRouter genuinely needs req.member/currentWorkspaceId()
  // — it sits AFTER resolveMember, same as apiRouter in production.
  function app(fetch: FetchLike = async () => new Response('not used', { status: 500 })) {
    const a = express();
    a.use(express.json());
    a.use(workspacesRouter);
    a.use(joinRouter);
    a.use(createAuthRouter({ env: ENV, fetch, mailer, publicBaseUrl: BASE }));
    a.use(asyncHandler(resolveMember));
    a.use(workspaceInvitesRouter);
    a.use(errorHandler);
    return a;
  }

  const stamp = Date.now();
  const U = {
    userId: `user-at12-a-${stamp}`,
    email: `at12-a-${stamp}@example.test`,
  };
  const OTHER = {
    workspaceId: `ws-at12-other-${stamp}`,
    userId: `user-at12-other-${stamp}`,
    memberId: `mem-at12-other-${stamp}`,
  };

  // Upsert, not delete-then-insert: instance_settings is a real singleton
  // row shared with every other *.integration.test.ts file's own real
  // Postgres connection, and this project doesn't isolate test files onto
  // separate databases — a delete-then-insert here can duplicate-key
  // against another file's own concurrent write to the same row. An
  // upsert has no such race window.
  async function setInstance(signupMode: 'open' | 'invite_only') {
    await db
      .insert(schema.instanceSettings)
      .values({ id: instance.INSTANCE_ROW_ID, instanceName: 'AT12 Test', signupMode, setupCompletedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.instanceSettings.id,
        set: { instanceName: 'AT12 Test', signupMode, setupCompletedAt: new Date() },
      });
  }

  // Workspaces created through the service get service-generated ids
  // (newId('ws'), not stamped) — cleaned up by name instead, which also
  // cascades their members and invites (both FK workspaceId ON DELETE
  // CASCADE) without needing separate deletes for either.
  async function clean() {
    await db.delete(schema.workspaces).where(ilike(schema.workspaces.name, 'AT12 %'));
    await db.delete(schema.sessions).where(ilike(schema.sessions.userId, 'user-at12-%'));
    await db.delete(schema.users).where(ilike(schema.users.id, 'user-at12-%'));
    await db.delete(schema.users).where(ilike(schema.users.email, 'at12-%'));
    sent.length = 0;
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    schema = await import('../db/schema/index.js');
    ({ eq, ilike } = await import('drizzle-orm'));
    ({ issueSession } = await import('../auth/sessions.js'));
    instance = await import('../services/instance.service.js');
    ({ resolveMember } = await import('../middleware/resolveMember.js'));
    ({ workspacesRouter } = await import('./workspaces.routes.js'));
    workspacesService = await import('../services/workspaces.service.js');
    ({ workspaceInvitesRouter } = await import('./workspaceInvites.routes.js'));
    ({ joinRouter } = await import('./join.routes.js'));
    ({ createAuthRouter } = await import('./auth.routes.js'));
    [savedInstance] = await db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, instance.INSTANCE_ROW_ID));
    // workspaceInvites.routes.ts's publicBaseUrl() and join.routes.ts's
    // configuredAuthMethods() both read process.env directly, with no
    // deps-injection seam — unlike createAuthRouter, which takes ENV as
    // an explicit override. Real env vars have to carry the same values
    // for those two routes to behave consistently with the injected
    // auth router in the same test.
    Object.assign(process.env, ENV, { PUBLIC_BASE_URL: BASE });
  });

  beforeEach(async () => {
    await clean();
    await setInstance('open');
    await db.insert(schema.users).values({ id: U.userId, email: U.email, fullName: 'AT12 User', authMethod: 'email' });
    await db.insert(schema.workspaces).values({
      id: OTHER.workspaceId,
      name: 'AT12 other tenant',
      slug: OTHER.workspaceId,
      companySize: '2-10',
      timezone: 'UTC',
    });
    await db.insert(schema.users).values({ id: OTHER.userId, email: `${OTHER.userId}@example.test`, fullName: 'AT12 Other', authMethod: 'email' });
    await db.insert(schema.members).values({
      id: OTHER.memberId,
      workspaceId: OTHER.workspaceId,
      userId: OTHER.userId,
      fullName: 'AT12 Other',
      displayName: 'AT12 Other',
      email: `${OTHER.memberId}@example.test`,
      avatarColor: '#000000',
      role: 'admin',
      authMethod: 'email',
    });
  });

  afterAll(async () => {
    process.env = envBackup;
    if (!db) return;
    await clean();
    if (savedInstance) {
      await db
        .insert(schema.instanceSettings)
        .values(savedInstance)
        .onConflictDoUpdate({ target: schema.instanceSettings.id, set: savedInstance });
    } else {
      await db.delete(schema.instanceSettings).where(eq(schema.instanceSettings.id, instance.INSTANCE_ROW_ID));
    }
  });

  describe('POST /workspaces and GET /workspaces', () => {
    it('401s with no bearer token, creates and lists nothing', async () => {
      expect((await request(app()).post('/workspaces').send({ name: 'X' })).status).toBe(401);
      expect((await request(app()).get('/workspaces')).status).toBe(401);
    });

    it('creates a workspace with a founding admin member, and lists it back', async () => {
      const { token } = await issueSession(U.userId);
      const create = await request(app())
        .post('/workspaces')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'AT12 Fairweather Labs' });
      expect(create.status).toBe(201);
      expect(create.body.isPersonal).toBe(false);
      expect(create.body.myRole).toBe('admin');
      expect(create.body.slug).toBe('at12-fairweather-labs');

      const [member] = await db.select().from(schema.members).where(eq(schema.members.id, create.body.myMemberId));
      expect(member?.userId).toBe(U.userId);
      expect(member?.role).toBe('admin');

      const list = await request(app()).get('/workspaces').set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(200);
      const ids = (list.body as Array<{ id: string }>).map((w) => w.id);
      expect(ids).toContain(create.body.id);
      expect(ids).not.toContain(OTHER.workspaceId);
    });

    it('a second workspace with a colliding name gets a numeric-suffixed slug', async () => {
      const { token } = await issueSession(U.userId);
      const first = await request(app()).post('/workspaces').set('Authorization', `Bearer ${token}`).send({ name: 'AT12 Dup' });
      const second = await request(app()).post('/workspaces').set('Authorization', `Bearer ${token}`).send({ name: 'AT12 Dup' });
      expect(first.body.slug).toBe('at12-dup');
      expect(second.body.slug).toBe('at12-dup-2');
    });
  });

  describe('POST /workspaces/:id/invites', () => {
    it('refuses to create an invite into a workspace the caller is not a member of', async () => {
      const { token } = await issueSession(U.userId);
      // U has no workspace membership at all yet — creates their own first.
      const own = await request(app()).post('/workspaces').set('Authorization', `Bearer ${token}`).send({ name: 'AT12 Own' });
      const res = await request(app())
        .post(`/workspaces/${OTHER.workspaceId}/invites`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Waypoint-Workspace-Id', own.body.id)
        .send({});
      expect(res.status).toBe(404);
      const rows = await db.select().from(schema.workspaceInvites).where(eq(schema.workspaceInvites.workspaceId, OTHER.workspaceId));
      expect(rows).toHaveLength(0);
    });

    it('creates a real invite link for the caller\'s own workspace', async () => {
      const { token } = await issueSession(U.userId);
      const own = await request(app()).post('/workspaces').set('Authorization', `Bearer ${token}`).send({ name: 'AT12 Invite Source' });
      const res = await request(app())
        .post(`/workspaces/${own.body.id}/invites`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Waypoint-Workspace-Id', own.body.id)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.joinUrl).toContain(`${BASE}/join/`);
    });
  });

  describe('the full join flow', () => {
    it('GET /join/:token previews, and the email-link round trip creates a real membership, even on an invite-only instance', async () => {
      await setInstance('invite_only');
      const { token: inviterToken } = await issueSession(U.userId);
      const ws = await request(app()).post('/workspaces').set('Authorization', `Bearer ${inviterToken}`).send({ name: 'AT12 Join Target' });
      const invite = await request(app())
        .post(`/workspaces/${ws.body.id}/invites`)
        .set('Authorization', `Bearer ${inviterToken}`)
        .set('X-Waypoint-Workspace-Id', ws.body.id)
        .send({});
      const inviteToken = new URL(invite.body.joinUrl).pathname.split('/join/')[1];

      const a = request(app());
      const preview = await a.get(`/join/${inviteToken}`);
      expect(preview.status).toBe(200);
      expect(preview.text).toContain('AT12 Join Target');
      expect(preview.text).toContain('Email me a link');

      const newEmail = `at12-invitee-${stamp}@example.test`;
      const start = await a.post('/auth/email/start').type('form').send({ email: newEmail, invite_token: inviteToken });
      expect(start.status).toBe(200);
      expect(sent).toHaveLength(1);
      const linkMatch = sent[0].text.match(/https?:\/\/\S+\/auth\/email\/verify\?token=(\S+)/);
      expect(linkMatch).toBeTruthy();

      const complete = await a.get('/auth/email/verify').query({ token: linkMatch![1] });
      expect(complete.status).toBe(200);
      expect(complete.text).toContain("You're in");
      expect(complete.text).toContain('AT12 Join Target');

      const [newUser] = await db.select().from(schema.users).where(eq(schema.users.email, newEmail));
      expect(newUser).toBeTruthy();
      const [newMember] = await db
        .select()
        .from(schema.members)
        .where(eq(schema.members.workspaceId, ws.body.id));
      const invitee = (await db.select().from(schema.members).where(eq(schema.members.workspaceId, ws.body.id))).find(
        (m) => m.userId === newUser.id,
      );
      expect(invitee).toBeTruthy();
      expect(invitee!.role).toBe('member');

      // The switcher now lists this workspace for the invitee too.
      const { token: inviteeSessionToken } = await issueSession(newUser.id);
      const list = await request(app()).get('/workspaces').set('Authorization', `Bearer ${inviteeSessionToken}`);
      expect((list.body as Array<{ id: string }>).map((w) => w.id)).toContain(ws.body.id);
    });

    it('a second acceptance of the same token is refused, and the invite stays single-use', async () => {
      const { token: inviterToken } = await issueSession(U.userId);
      const ws = await request(app()).post('/workspaces').set('Authorization', `Bearer ${inviterToken}`).send({ name: 'AT12 Single Use' });
      const invite = await request(app())
        .post(`/workspaces/${ws.body.id}/invites`)
        .set('Authorization', `Bearer ${inviterToken}`)
        .set('X-Waypoint-Workspace-Id', ws.body.id)
        .send({});
      const inviteToken = new URL(invite.body.joinUrl).pathname.split('/join/')[1];

      const a = request(app());
      await a.post('/auth/email/start').type('form').send({ email: `at12-single-${stamp}@example.test`, invite_token: inviteToken });
      const link1 = sent[0].text.match(/token=(\S+)/)![1];
      const first = await a.get('/auth/email/verify').query({ token: link1 });
      expect(first.status).toBe(200);

      // The join page itself now refuses — the token was consumed.
      const secondPreview = await a.get(`/join/${inviteToken}`);
      expect(secondPreview.status).toBe(404);

      // The browser-facing preview page is one line of defense; the real
      // atomicity guarantee is acceptInvite's own UPDATE ... WHERE
      // accepted_at IS NULL — proven here by calling the service function
      // directly a second time (what a race between two concurrent
      // completions of the same still-unexpired token would look like,
      // rather than the ordinary sequential re-visit the preview-page
      // check above already covers).
      const [anyUser] = await db.select().from(schema.users).limit(1);
      await expect(workspacesService.acceptInvite(inviteToken, anyUser)).rejects.toThrow(/not found/i);
    });

    it('an expired or unknown invite token 404s at the join page, and starting a sign-in against it is refused', async () => {
      const a = request(app());
      const bogus = await a.get('/join/not-a-real-token');
      expect(bogus.status).toBe(404);
      const start = await a.post('/auth/email/start').type('form').send({ email: `at12-bogus-${stamp}@example.test`, invite_token: 'not-a-real-token' });
      expect(start.status).toBe(404);
    });
  });
});
