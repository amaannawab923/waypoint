import type { Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { members } from '../db/schema/index.js';
import { resolveSession, touchSession } from '../auth/sessions.js';
import { runWithIdentity } from '../lib/requestContext.js';
import { bearer } from './auth.js';

// AT11 (ROAD-146). The hosted-backend-only identity resolver. Spec:
// docs/design/self-hosted-auth-and-multitenancy.md §6.
//
// No Authorization header at all → Personal. `next()` runs with no
// identity in the AsyncLocalStorage context, so every service's
// currentMemberId()/currentWorkspaceId() fall back to the
// CURRENT_USER_ID/WORKSPACE_ID constants exactly as today — this
// middleware is additive, not a gate every existing request now has to
// clear.
//
// A Bearer token present changes that: this is now a real person on a
// real session, and every failure past this point is a real refusal,
// not a fallback — an invalid, expired, or unrecognized token is 401; a
// missing or unrecognized X-Waypoint-Workspace-Id is 400/403. The header
// (not a route param) because almost nothing in this API is already
// workspace-scoped in its URL (`/tickets`, `/projects`, `/members` — no
// `/workspaces/:id/...` prefix anywhere), and adding one to every route
// would be a far larger, riskier change than this ticket's actual job.
export async function resolveMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  if (!token) {
    next();
    return;
  }

  const resolved = await resolveSession(token);
  if (!resolved) {
    res.status(401).json({ error: 'invalid_session', message: 'This session is invalid or has expired. Sign in again.' });
    return;
  }
  const { user, session } = resolved;

  const workspaceId = req.header('x-waypoint-workspace-id');
  if (!workspaceId) {
    res.status(400).json({
      error: 'workspace_required',
      message: 'X-Waypoint-Workspace-Id is required once signed in — a session can belong to more than one workspace.',
    });
    return;
  }

  const [member] = await db
    .select()
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, user.id)));
  if (!member) {
    // 403, not 404: the workspace itself may well exist — what's refused
    // is this person's membership in it. Deliberately doesn't distinguish
    // "no such workspace" from "not a member of it" beyond that, so a
    // signed-in stranger can't use this response to enumerate real
    // workspace ids.
    res.status(403).json({ error: 'not_a_member', message: "You aren't a member of that workspace." });
    return;
  }

  req.user = user;
  req.member = member;

  // Best-effort — a session's own usability was already established
  // above by resolveSession succeeding; a failed touch shouldn't turn a
  // valid request into a 500 over a "last seen" timestamp.
  touchSession(session.id, session.lastSeenAt).catch(() => {});

  runWithIdentity(
    { userId: user.id, memberId: member.id, workspaceId: member.workspaceId, role: member.role },
    next,
  );
}

// req.user's Express.Request augmentation already lives in
// middleware/auth.ts (AT8) — this module only adds req.member alongside
// it, in the same declare-global block shape.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      member?: typeof members.$inferSelect;
    }
  }
}
