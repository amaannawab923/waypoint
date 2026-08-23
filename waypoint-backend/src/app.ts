import express from 'express';
import cors from 'cors';
import { apiRouter } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';

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
  // clients bypass it by sending no Origin at all; the loopback binding in
  // docker-compose.yml is what actually stops those).
  //
  // Two legitimate origins, not one: the webpack dev server
  // (http://localhost:1212) during development, and the packaged app's
  // custom app://waypoint scheme in production — registered `standard:
  // true` in main.ts, which gives it a real origin Chromium does send,
  // unlike a plain file:// load. Restricting to only the dev origin here
  // previously shipped a packaged build that silently failed every API
  // call. CORS_ORIGIN overrides both defaults with a comma-separated list
  // — see .env.example.
  const defaultAllowedOrigins = 'http://localhost:1212,app://waypoint';
  // `||`, not `??` — CORS_ORIGIN="" (e.g. a blanked-out .env value, as
  // opposed to leaving it commented out per .env.example) would otherwise
  // survive as a truthy empty string, split into [''], and reject every
  // origin including the packaged app's, failing the whole API closed with
  // no indication why.
  const allowedOrigins = (process.env.CORS_ORIGIN || defaultAllowedOrigins).split(',').map((o) => o.trim());
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

  app.use(apiRouter);

  app.use(errorHandler);

  return app;
}
