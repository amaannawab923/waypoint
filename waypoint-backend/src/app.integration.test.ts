import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import postgres from 'postgres';

// AT13 (ROAD-148) QA pass. A real browser reaching the sign-in/join pages
// directly — not the desktop app's own fetch — sends an Origin header on
// its form POST, same as any other cross-origin-looking request. app.ts's
// cors() allowlist only ever contemplated the desktop app's own origins
// (the webpack dev server, app://waypoint), so every real self-hosted
// sign-in was silently 403ing before this fix — caught live, not by
// reading the code, since every curl-based check this epic ran until now
// never sent an Origin header at all and so never hit this path.
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

describe.skipIf(!REAL_DB)('publicPageRouter is reachable from a real browser origin (AT13)', () => {
  let app: express.Express;

  const A_FOREIGN_ORIGIN = 'http://a-real-browser-tab.example';

  it('serves /sign-in even with an Origin header no allowlist could ever contain', async () => {
    const { createApp } = await import('./app.js');
    app = createApp();

    const res = await request(app)
      .get('/sign-in')
      .query({ redirect_uri: 'http://127.0.0.1:45999/callback', state: 'a-real-32-char-or-longer-state-value' })
      .set('Origin', A_FOREIGN_ORIGIN);

    // 503 (setup not completed on whatever instance this runs against) is
    // an acceptable outcome here — the point is it's not the 403 a CORS
    // rejection would have produced; either status means the request
    // reached the route handler at all.
    expect([200, 503]).toContain(res.status);
  });

  it('still blocks that same foreign Origin from the JSON API this CORS policy actually protects', async () => {
    const { createApp } = await import('./app.js');
    app = createApp();

    const res = await request(app).get('/workspaces').set('Origin', A_FOREIGN_ORIGIN).set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(403);
  });

  it('still serves the same JSON API route for the desktop app\'s own origin', async () => {
    const { createApp } = await import('./app.js');
    app = createApp();

    const res = await request(app).get('/workspaces').set('Origin', 'app://waypoint').set('Authorization', 'Bearer not-a-real-token');

    // 401, not 403 — the request reached the route handler; it's the bad
    // token failing, not CORS.
    expect(res.status).toBe(401);
  });
});
