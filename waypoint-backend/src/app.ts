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
  // workspace data. Non-browser clients (curl, the packaged Electron app
  // loading over file://, which sends no Origin header) still work, since
  // only the empty-origin and known-dev-origin cases are allowed through.
  const allowedOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:1212';
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === allowedOrigin) {
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
