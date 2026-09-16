import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import postgres from 'postgres';

// AT13 (ROAD-148) QA pass. A real browser reaching /sign-in or
// /join/:token directly (not through the desktop app's own fetch)
// submits a same-origin form POST back to this same backend — and a
// same-origin POST still carries a real Origin header, unlike the GET
// navigation that got it there in the first place (real browsers send no
// Origin on a plain top-level GET, so that half of the flow was never
// actually broken). That origin is this backend's own
// (auth/redirect.ts's publicBaseUrl), never going to be in an allowlist
// built for the desktop app's origins — so POST /auth/email/start
// 403'd for every real browser before this fix, caught live rather than
// by reading the code: every curl-based check this epic ran until now
// never sent an Origin header at all, masking it entirely.
//
// Skipped, not failed, without a reachable database — same convention as
// every other *.integration.test.ts file in this project.
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

describe.skipIf(!REAL_DB)("this backend's own origin is allowed through CORS (AT13)", () => {
  let app: express.Express;
  let publicBaseUrl: typeof import('./auth/redirect.js')['publicBaseUrl'];
  let corsOriginsForBackend: typeof import('./auth/redirect.js')['corsOriginsForBackend'];

  const A_FOREIGN_ORIGIN = 'http://a-real-browser-tab.example';

  it("accepts POST /auth/email/start from this backend's own origin — the exact request shape that 403'd before this fix", async () => {
    ({ publicBaseUrl } = await import('./auth/redirect.js'));
    const { createApp } = await import('./app.js');
    app = createApp();

    const res = await request(app)
      .post('/auth/email/start')
      .type('form')
      .set('Origin', publicBaseUrl(process.env))
      .send({ email: `qa-${Date.now()}@example.test`, redirect_uri: 'http://127.0.0.1:45999/callback', state: 'a-real-32-char-or-longer-state-value' });

    // Not 403: the request reached the route handler. A real outcome
    // (200 "check your email", or a 400/503 from setup/config state on
    // whatever instance this runs against) both prove the same thing —
    // CORS didn't block it.
    expect(res.status).not.toBe(403);
  });

  // Round-3 review: the previous version of this fix only trusted
  // publicBaseUrl()'s own exact spelling, not the sibling loopback
  // hostname — reproducing the original bug for an operator whose
  // desktop points at 127.0.0.1 while this backend's PUBLIC_BASE_URL
  // defaults to localhost (or the reverse).
  it('accepts that same request from this backend\'s sibling loopback spelling too', async () => {
    ({ publicBaseUrl, corsOriginsForBackend } = await import('./auth/redirect.js'));
    const { createApp } = await import('./app.js');
    app = createApp();

    const [, sibling] = corsOriginsForBackend(publicBaseUrl(process.env));
    expect(sibling).toBeDefined(); // this env's own base URL must be loopback for this case to mean anything

    const res = await request(app)
      .post('/auth/email/start')
      .type('form')
      .set('Origin', sibling!)
      .send({ email: `qa-${Date.now()}@example.test`, redirect_uri: 'http://127.0.0.1:45999/callback', state: 'a-real-32-char-or-longer-state-value' });

    expect(res.status).not.toBe(403);
  });

  it('still rejects that same route for an origin with no legitimate reason to call it', async () => {
    const { createApp } = await import('./app.js');
    app = createApp();

    const res = await request(app)
      .post('/auth/email/start')
      .type('form')
      .set('Origin', A_FOREIGN_ORIGIN)
      .send({ email: 'someone@example.test', redirect_uri: 'http://127.0.0.1:45999/callback', state: 'a-real-32-char-or-longer-state-value' });

    expect(res.status).toBe(403);
  });

  it('still blocks that same foreign origin from the JSON API this CORS policy actually protects', async () => {
    const { createApp } = await import('./app.js');
    app = createApp();

    const res = await request(app).get('/workspaces').set('Origin', A_FOREIGN_ORIGIN).set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(403);
  });

  it("still serves the same JSON API route for the desktop app's own origin", async () => {
    const { createApp } = await import('./app.js');
    app = createApp();

    const res = await request(app).get('/workspaces').set('Origin', 'app://waypoint').set('Authorization', 'Bearer not-a-real-token');

    // 401, not 403 — the request reached the route handler; it's the bad
    // token failing, not CORS.
    expect(res.status).toBe(401);
  });
});
