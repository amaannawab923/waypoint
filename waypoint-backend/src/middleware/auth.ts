import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { users } from '../db/schema/index.js';
import { ServiceUnavailableError } from './errors.js';

// AT8 (ROAD-143). The two guards this ticket introduces. Neither resolves
// a session — that is AT11's middleware, which will attach `req.user`
// from a bearer token. Until it lands, nothing sets `req.user`, so every
// admin route answers 401: closed by default, not open by accident.

export type AuthUser = typeof users.$inferSelect;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ', 2);
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

function withStatus(message: string, status: number): Error & { status: number } {
  // errorHandler.ts trusts a 4xx/5xx `.status` on a thrown error — same
  // path the CORS rejection uses.
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// Gates first-run setup on the operator-supplied INSTANCE_SETUP_TOKEN
// (spec §4, AT8 amendment). Constant-time compare so the token can't be
// guessed a byte at a time; 503 when the operator hasn't set one, because
// "setup is impossible" is a configuration state, not a client error.
//
// The env is read per request, not captured when the router is built.
export function requireSetupToken(getEnv: () => NodeJS.ProcessEnv = () => process.env) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const expected = getEnv().INSTANCE_SETUP_TOKEN?.trim();
    if (!expected) {
      next(new ServiceUnavailableError('INSTANCE_SETUP_TOKEN is not configured on this instance'));
      return;
    }
    const given = bearer(req);
    const a = Buffer.from(given ?? '');
    const b = Buffer.from(expected);
    if (!given || a.length !== b.length || !timingSafeEqual(a, b)) {
      next(withStatus('Invalid setup token', 401));
      return;
    }
    next();
  };
}

export function requireInstanceAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(withStatus('Sign in required', 401));
    return;
  }
  if (!req.user.isInstanceAdmin) {
    next(withStatus('Instance admin required', 403));
    return;
  }
  next();
}
