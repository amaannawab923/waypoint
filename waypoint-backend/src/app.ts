import express from 'express';
import cors from 'cors';
import { apiRouter, identityOnlyRouter } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { asyncHandler } from './middleware/asyncHandler.js';
import { resolveMember } from './middleware/resolveMember.js';
import { publicBaseUrl } from './auth/redirect.js';

export function createApp() {
  const app = express();
  // Origin is restricted (not auth — there's still none in this phase) so
  // an arbitrary webpage a developer has open can't call this API from a
  // background fetch() while the stack is running; a wildcard origin
  // combined with no auth meant any site could read or write real
  // workspace data. This can't be bypassed by a malicious page forging the
  // header — Origin is a forbidden header name, set by the browser itself
  // and not writable from page JS — so it's a real control against
  // browser-based attackers specifically (curl and other non-browser
  // clients bypass it by sending no Origin at all; what actually stops
  // those is HOST-gated bind behavior in index.ts's
  // app.listen(port, host, ...): the documented `npm run dev` path defaults
  // HOST to 127.0.0.1, closing it to the LAN outright, while
  // docker-compose.yml sets HOST=0.0.0.0 for the api container — that
  // container binds wide, but stays off the LAN via that same compose
  // file's 127.0.0.1 publish rule instead of via its own bind address).
  //
  // Two legitimate origins, not one: the webpack dev server
  // (http://localhost:11212 — moved off webpack-dev-server's conventional
  // 1212 to avoid colliding with another project on the same dev machine,
  // see .erb/configs/webpack.config.renderer.dev.ts) during development,
  // and the packaged app's custom app://waypoint scheme in production —
  // registered `standard: true` in main.ts, which gives it a real origin
  // Chromium does send, unlike a plain file:// load. Restricting to only
  // the dev origin here previously shipped a packaged build that silently
  // failed every API call. CORS_ORIGIN overrides both defaults with a
  // comma-separated list — see .env.example.
  const defaultAllowedOrigins = 'http://localhost:11212,app://waypoint';
  // `||`, not `??` — CORS_ORIGIN="" (e.g. a blanked-out .env value, as
  // opposed to leaving it commented out per .env.example) would otherwise
  // survive as a truthy empty string, split into [''], and reject every
  // origin including the packaged app's, failing the whole API closed with
  // no indication why.
  const configuredOrigins = (process.env.CORS_ORIGIN || defaultAllowedOrigins).split(',').map((o) => o.trim());
  // Always allowed, and deliberately not foldable into CORS_ORIGIN's own
  // override above: a real browser reaching /sign-in or /join/:token
  // directly (not through the desktop app's own fetch) submits a
  // same-origin form POST back to this same backend — and a same-origin
  // POST still carries a real Origin header, unlike the GET navigation
  // that got it there. That origin is this backend's own
  // (auth/redirect.ts's publicBaseUrl, the same value already used to
  // build every OAuth callback URL), never going to be in an allowlist
  // built for the desktop app's origins. Missing this exact case 403'd
  // every real self-hosted sign-in attempt — found live, since every
  // curl-based check this epic ran until now never sent an Origin header
  // at all. Kept as a real origin check rather than exempting these
  // routes from it entirely (an earlier version of this fix tried that,
  // routing them before this middleware — round 2 review found it also
  // exempted POST /auth/email/start, side-effectful and previously
  // curl-only-reachable, from CORS with no rate limiting anywhere in this
  // backend to fall back on): this way every route these pages expose
  // stays behind the same check, just with the one legitimate additional
  // origin these pages themselves run on.
  const allowedOrigins = [...configuredOrigins, publicBaseUrl(process.env)];
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        // Give it a trusted 4xx `.status` so errorHandler.ts's existing
        // trustedHttpStatus() path returns a clean 403 instead of falling
        // through to a generic 500 — see errorHandler.ts for why that
        // matters (PayloadTooLargeError hit the same gap before it had a
        // status either).
        const err = new Error(`Origin ${origin} is not allowed`) as Error & { status: number };
        err.status = 403;
        callback(err);
      },
    }),
  );
  // strict:false — PUT /projects/:id/estimate legitimately sends a bare
  // `null` body (clearing the estimate system) and express.json()'s default
  // strict mode rejects any top-level JSON value that isn't an object or
  // array, which otherwise surfaced as a raw 500 for that one endpoint.
  //
  // limit: body-parser's default is 100kb, easily hit by a real page body,
  // a long comment thread, or a pasted description with embedded content —
  // and the resulting PayloadTooLargeError isn't a SyntaxError, a ZodError,
  // or a Postgres error, so it fell through every explicit errorHandler
  // branch to a raw 500. Set explicitly (rather than silently inheriting
  // the default) and paired with real handling in errorHandler.ts.
  app.use(express.json({ strict: false, limit: '5mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // AT12 (ROAD-147): instance setup, sign-in/join pages, and workspace
  // creation/listing all need at most req.user (or no identity at all) —
  // never req.member. Mounted before resolveMember for the same reason
  // /health is: resolveMember hard-refuses any request carrying a bearer
  // token but no X-Waypoint-Workspace-Id header, which would otherwise
  // block every one of these before their own, more permissive guard
  // (requireUser, or none) ever ran. See routes/index.ts's own comment.
  app.use(identityOnlyRouter);

  // AT11 (ROAD-146): resolves a Bearer session to req.user/req.member and
  // an AsyncLocalStorage identity every service reads via
  // lib/requestContext.ts's currentMemberId()/currentWorkspaceId(). A
  // request with no Authorization header passes straight through — this
  // is additive to the existing Personal (unauthenticated) path, not a
  // gate in front of it. Mounted after /health (which needs no identity)
  // and before every other route. Wrapped in asyncHandler for the same
  // reason every route in this project is: Express 4 doesn't catch a
  // rejected promise from an async middleware on its own, and this one
  // does real async work (resolveSession, a members lookup) before ever
  // calling next().
  app.use(asyncHandler(resolveMember));

  app.use(apiRouter);

  app.use(errorHandler);

  return app;
}
