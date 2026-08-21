import express from 'express';
import cors from 'cors';
import { apiRouter } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  // Permissive for now — no real auth in this phase (single local user), and
  // the Electron renderer's dev server (localhost:1212) and the API
  // (localhost:4000) are different origins, so the browser enforces CORS
  // even though this is all one machine. Revisit once real auth exists.
  app.use(cors());
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
