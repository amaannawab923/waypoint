import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { users } from '../db/schema/index.js';
import { ServiceUnavailableError } from './errors.js';
import { resolveSession, touchSession } from '../auth/sessions.js';

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

// Exported for the one JSON API route (auth.routes.ts's POST /auth/signout,
// AT10) that has to read a session bearer token before AT11's middleware
// exists to attach req.user from it — everything else here stays a plain
// guard, not a resolver.
export function bearer(req: Request): string | null {
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

// AT12 (ROAD-147). Found while wiring workspace creation: middleware/
// resolveMember.ts only ever sets req.user AFTER also resolving a
// workspace + membership (400/403 otherwise) — so a route that needs
// nothing more than "who is this real, signed-in person" (creating their
// first workspace, listing every workspace they belong to, or — this same
// gap — requireInstanceAdmin above, whose own AT8-era comment assumed
// req.user would already be set by any valid bearer token) can't sit
// behind resolveMember at all. This resolves a bearer token to req.user
// on its own, with no workspace involvement — a strict subset of what
// resolveMember does, not a competing identity path.
export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  if (!token) {
    next(withStatus('Sign in required', 401));
    return;
  }
  const resolved = await resolveSession(token);
  if (!resolved) {
    next(withStatus('This session is invalid or has expired. Sign in again.', 401));
    return;
  }
  req.user = resolved.user;
  touchSession(resolved.session.id, resolved.session.lastSeenAt).catch(() => {});
  next();
}
