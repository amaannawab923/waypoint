import 'dotenv/config';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import postgres from 'postgres';
import { errorHandler } from '../middleware/errorHandler.js';
import type { FetchLike } from '../auth/providers/types.js';
import type { Mailer } from '../auth/mailer.js';

// AT9 (ROAD-144): the whole sign-in round trip against real Postgres —
// the desktop opens /sign-in, the browser goes to the provider and comes
// back, a users row is resolved or linked, a session is issued, and the
// browser is sent to the loopback callback with the token. The provider
// and the mailer are fakes (no network, nothing sent); the auth_flows
// single-use guarantee, the linking rule from decision 001 §3, and the
// invite-only refusal are the things only the real database can prove.
// Skipped, not failed, without a reachable database.
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
const LOOPBACK = 'http://127.0.0.1:53127/callback';
const STATE = 'at9-client-state-0001';

function fakeGithub(user: { id: number; login: string; name: string | null; email: string; verified?: boolean }): FetchLike {
  return async (input: string) => {
    if (input.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    if (input.startsWith('https://api.github.com/user/emails')) {
      return new Response(JSON.stringify([{ email: user.email, primary: true, verified: user.verified ?? true }]), { status: 200 });
    }
    // GitHub leaves the profile email null for most developers; when the
    // fake is asked to report "unverified", surface it there instead so
    // the exchange still finds an address.
    const profileEmail = user.verified === false ? user.email : null;
    return new Response(JSON.stringify({ id: user.id, login: user.login, name: user.name, email: profileEmail, avatar_url: 'https://a/x.png' }), { status: 200 });
  };
}

const failingGithub: FetchLike = async () =>
  new Response(JSON.stringify({ error: 'bad_verification_code', error_description: 'expired' }), { status: 200 });

describe.skipIf(!REAL_DB)('sign-in flows against real Postgres (AT9)', () => {
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let sessions: typeof import('../auth/sessions.js');
  let createAuthRouter: typeof import('./auth.routes.js')['createAuthRouter'];
  let instance: typeof import('../services/instance.service.js');
  let eq: typeof import('drizzle-orm')['eq'];
  let ilike: typeof import('drizzle-orm')['ilike'];
  let savedInstance: typeof schema.instanceSettings.$inferSelect | undefined;
  const sent: Array<{ to: string; text: string }> = [];
  const mailer: Mailer = {
    async send(msg) {
      sent.push({ to: msg.to, text: msg.text });
    },
  };

  function app(fetch: FetchLike = fakeGithub({ id: 4242, login: 'amaan', name: 'Amaan N', email: 'at9-amaan@example.test' })) {
    const a = express();
    a.use(createAuthRouter({ env: ENV, fetch, mailer, publicBaseUrl: BASE }));
    a.use(errorHandler);
    return a;
  }

  async function setInstance(signupMode: 'open' | 'invite_only') {
    await db.delete(schema.instanceSettings).where(eq(schema.instanceSettings.id, instance.INSTANCE_ROW_ID));
    await db.insert(schema.instanceSettings).values({ id: instance.INSTANCE_ROW_ID, instanceName: 'AT9 Test', signupMode, setupCompletedAt: new Date() });
  }

  async function clean() {
    await db.delete(schema.authFlows).where(ilike(schema.authFlows.clientState, 'at9-%'));
    await db.delete(schema.users).where(ilike(schema.users.email, 'at9-%'));
    sent.length = 0;
  }

  // Runs the GitHub round trip and returns the final loopback redirect.
  async function githubRoundTrip(a: ReturnType<typeof app>, purpose?: string) {
    const start = await a.get('/auth/github/start').query({ redirect_uri: LOOPBACK, state: STATE, ...(purpose ? { for: purpose } : {}) });
    expect(start.status).toBe(302);
    const providerUrl = new URL(start.headers.location);
    expect(providerUrl.origin).toBe('https://github.com');
    expect(providerUrl.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/github/callback`);
    const providerState = providerUrl.searchParams.get('state')!;
    const cb = await a.get('/auth/github/callback').query({ code: 'c0de', state: providerState });
    return { cb, providerState };
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    schema = await import('../db/schema/index.js');
    sessions = await import('../auth/sessions.js');
    ({ createAuthRouter } = await import('./auth.routes.js'));
    instance = await import('../services/instance.service.js');
    ({ eq, ilike } = await import('drizzle-orm'));
    [savedInstance] = await db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, instance.INSTANCE_ROW_ID));
  });

  beforeEach(async () => {
    await clean();
    await setInstance('open');
  });

  afterAll(async () => {
    await clean();
    await db.delete(schema.instanceSettings).where(eq(schema.instanceSettings.id, instance.INSTANCE_ROW_ID));
    if (savedInstance) await db.insert(schema.instanceSettings).values(savedInstance);
  });

  it('renders the sign-in page with only the configured methods, and refuses before setup', async () => {
    const a = request(app());
    const ok = await a.get('/sign-in').query({ redirect_uri: LOOPBACK, state: STATE, for: 'fairweather-labs' });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Continue with GitHub');
    expect(ok.text).not.toContain('Continue with Google');
    expect(ok.text).toContain('Email me a link');
    expect(ok.text).toContain('join fairweather-labs');
    expect(ok.text).toContain('never needs an account');

    const bad = await a.get('/sign-in').query({ redirect_uri: 'https://evil.example/callback', state: STATE });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("didn't complete");

    await db.delete(schema.instanceSettings).where(eq(schema.instanceSettings.id, instance.INSTANCE_ROW_ID));
    const pre = await a.get('/sign-in').query({ redirect_uri: LOOPBACK, state: STATE });
    expect(pre.status).toBe(503);
  });

  it('GitHub: creates the user on an open instance, issues a session, and redirects to the loopback with token + state + for', async () => {
    const a = request(app());
    const { cb, providerState } = await githubRoundTrip(a, 'fairweather-labs');
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.location);
    expect(back.origin + back.pathname).toBe(LOOPBACK);
    expect(back.searchParams.get('state')).toBe(STATE);
    expect(back.searchParams.get('for')).toBe('fairweather-labs');
    const token = back.searchParams.get('token')!;
    expect(token.length).toBeGreaterThan(30);

    const resolved = await sessions.resolveSession(token);
    expect(resolved?.user).toMatchObject({ email: 'at9-amaan@example.test', authMethod: 'github', authProviderId: '4242', fullName: 'Amaan N' });
    expect(resolved?.user.emailVerifiedAt).toBeInstanceOf(Date);
    // Only the hash is stored.
    expect(resolved?.session.tokenHash).not.toBe(token);

    // The provider state is single-use.
    const again = await a.get('/auth/github/callback').query({ code: 'c0de', state: providerState });
    expect(again.status).toBe(404);
    expect(again.headers.location).toBeUndefined();
  });

  it('links an existing unverified row (a local profile or the setup admin) instead of creating a second user', async () => {
    const [local] = await db
      .insert(schema.users)
      .values({ id: 'at9-user-local', email: 'AT9-Amaan@example.test', fullName: 'You', authMethod: 'email', emailVerifiedAt: null, isInstanceAdmin: true })
      .returning();
    const { cb } = await githubRoundTrip(request(app()));
    const token = new URL(cb.headers.location).searchParams.get('token')!;
    const resolved = await sessions.resolveSession(token);
    expect(resolved?.user.id).toBe(local.id);
    expect(resolved?.user).toMatchObject({ authMethod: 'github', authProviderId: '4242', isInstanceAdmin: true, email: 'at9-amaan@example.test' });
    expect(resolved?.user.emailVerifiedAt).toBeInstanceOf(Date);
    const rows = await db.select().from(schema.users).where(ilike(schema.users.email, 'at9-amaan%'));
    expect(rows).toHaveLength(1);
  });

  it('SECURITY: an unverified provider email can neither claim an existing row nor create one — the review-1 takeover path', async () => {
    // AT8's setup admin: an unverified row, isInstanceAdmin. The attack:
    // a GitHub account whose *profile* email is the admin's address but
    // which GitHub has not verified.
    await db.insert(schema.users).values({ id: 'at9-user-admin', email: 'at9-admin@example.test', fullName: 'Op', authMethod: 'github', isInstanceAdmin: true });
    const attacker: FetchLike = async (input: string) => {
      if (input.startsWith('https://github.com/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      if (input.startsWith('https://api.github.com/user/emails')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ id: 666, login: 'mallory', name: 'Mallory', email: 'at9-admin@example.test', avatar_url: null }), { status: 200 });
    };
    const { cb } = await githubRoundTrip(request(app(attacker)));
    expect(cb.status).toBe(403);
    expect(cb.headers.location).toBeUndefined();
    expect(cb.text).toMatch(/isn(&#39;|')t verified/);
    const [admin] = await db.select().from(schema.users).where(eq(schema.users.id, 'at9-user-admin'));
    expect(admin).toMatchObject({ authProviderId: null, emailVerifiedAt: null, isInstanceAdmin: true });
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, 'at9-user-admin'))).toHaveLength(0);

    // Same identity against an address nobody holds: still refused —
    // an unverified email may not create a row either, or a later
    // verified owner would inherit the attacker's provider binding.
    const stranger: FetchLike = async (input: string) => {
      if (input.startsWith('https://github.com/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      if (input.startsWith('https://api.github.com/user/emails')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ id: 667, login: 'm2', name: null, email: 'at9-nobody@example.test', avatar_url: null }), { status: 200 });
    };
    expect((await githubRoundTrip(request(app(stranger)))).cb.status).toBe(403);
    expect(await db.select().from(schema.users).where(eq(schema.users.email, 'at9-nobody@example.test'))).toHaveLength(0);
  });

  it('a returning provider subject signs in even if the provider now reports the email unverified', async () => {
    const first = await githubRoundTrip(request(app(fakeGithub({ id: 4242, login: 'amaan', name: 'Amaan N', email: 'at9-amaan@example.test' }))));
    expect(first.cb.status).toBe(302);
    const again = await githubRoundTrip(request(app(fakeGithub({ id: 4242, login: 'amaan', name: 'Amaan N', email: 'at9-amaan@example.test', verified: false }))));
    expect(again.cb.status).toBe(302);
    expect(await db.select().from(schema.users).where(ilike(schema.users.email, 'at9-amaan%'))).toHaveLength(1);
  });

  it('a second provider with the same verified email signs in but does not overwrite the first binding', async () => {
    await db.insert(schema.users).values({ id: 'at9-user-g', email: 'at9-amaan@example.test', fullName: 'Amaan', authMethod: 'google', authProviderId: 'g-110', emailVerifiedAt: new Date() });
    const { cb } = await githubRoundTrip(request(app()));
    expect(cb.status).toBe(302);
    const token = new URL(cb.headers.location).searchParams.get('token')!;
    const resolved = await sessions.resolveSession(token);
    expect(resolved?.user).toMatchObject({ id: 'at9-user-g', authMethod: 'google', authProviderId: 'g-110' });
  });

  it('invite-only: refuses a stranger with a page and creates nothing; lets a pre-created person in', async () => {
    await setInstance('invite_only');
    const stranger = await githubRoundTrip(request(app(fakeGithub({ id: 9, login: 'stranger', name: null, email: 'at9-stranger@example.test' }))));
    expect(stranger.cb.status).toBe(403);
    expect(stranger.cb.text).toContain('invite-only');
    expect(await db.select().from(schema.users).where(eq(schema.users.email, 'at9-stranger@example.test'))).toHaveLength(0);

    await db.insert(schema.users).values({ id: 'at9-user-invited', email: 'at9-invited@example.test', fullName: 'Invited', authMethod: 'email' });
    const invited = await githubRoundTrip(request(app(fakeGithub({ id: 10, login: 'inv', name: 'Invited', email: 'at9-invited@example.test' }))));
    expect(invited.cb.status).toBe(302);
  });

  it('a failed provider exchange renders a 502 page, never a loopback redirect, and burns the state', async () => {
    const a = request(app(failingGithub));
    const { cb, providerState } = await githubRoundTrip(a);
    expect(cb.status).toBe(502);
    expect(cb.headers.location).toBeUndefined();
    expect(cb.text).toContain('expired');
    const retry = await a.get('/auth/github/callback').query({ code: 'c0de', state: providerState });
    expect(retry.status).toBe(404);
  });

  it('a state minted for one provider cannot complete another', async () => {
    const a = request(app());
    const start = await a.get('/auth/github/start').query({ redirect_uri: LOOPBACK, state: STATE });
    const providerState = new URL(start.headers.location).searchParams.get('state')!;
    const res = await a.get('/auth/google/callback').query({ code: 'c0de', state: providerState });
    // The lookup is keyed on (hash, provider): a GitHub state is simply
    // unknown to the Google callback. 404, and nothing is consumed —
    // the GitHub callback can still complete it.
    expect(res.status).toBe(404);
    expect((await a.get('/auth/github/callback').query({ code: 'c0de', state: providerState })).status).toBe(302);
  });

  it('email link: sends one link, the click signs in once, verifies the address, and the link is then dead', async () => {
    const a = request(app());
    const start = await a
      .post('/auth/email/start')
      .type('form')
      .send({ email: 'AT9-Jordan@example.test', redirect_uri: LOOPBACK, state: STATE, for: 'sync' });
    expect(start.status).toBe(200);
    expect(start.text).toContain('Check your email');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('at9-jordan@example.test');
    const link = sent[0].text.match(/https?:\/\/\S+/)![0];
    expect(link.startsWith(`${BASE}/auth/email/verify?token=`)).toBe(true);

    const verify = await a.get(new URL(link).pathname + new URL(link).search);
    expect(verify.status).toBe(302);
    const back = new URL(verify.headers.location);
    expect(back.origin + back.pathname).toBe(LOOPBACK);
    expect(back.searchParams.get('for')).toBe('sync');
    const resolved = await sessions.resolveSession(back.searchParams.get('token')!);
    expect(resolved?.user).toMatchObject({ email: 'at9-jordan@example.test', authMethod: 'email', authProviderId: null });
    expect(resolved?.user.emailVerifiedAt).toBeInstanceOf(Date);

    const dead = await a.get(new URL(link).pathname + new URL(link).search);
    expect(dead.status).toBe(404);
  });

  it('sessions: an unknown or expired token resolves to null; revoke works', async () => {
    const { cb } = await githubRoundTrip(request(app()));
    const token = new URL(cb.headers.location).searchParams.get('token')!;
    expect(await sessions.resolveSession('not-a-token')).toBeNull();
    expect(await sessions.resolveSession(token, new Date(Date.now() + sessions.SESSION_TTL_MS + 1000))).toBeNull();
    expect(await sessions.revokeSession(token)).toBe(true);
    expect(await sessions.resolveSession(token)).toBeNull();
    expect(await sessions.revokeSession(token)).toBe(false);
  });
});
