import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, tickets } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { currentWorkspaceId } from './requestContext.js';

// AT11 (ROAD-146). The workspace-scoping audit's shared building block.
// Every table this ticket's audit covers is project-scoped, not
// workspace-scoped directly — a ticket/doc/view/workstream/sprint knows
// its projectId, not its workspaceId — so the actual check everywhere is
// "does this project belong to the caller's current workspace."
//
// Returns 404, never 403: a project in another workspace and a project
// that plain doesn't exist must look identical to the caller, the same
// non-distinguishing-existence discipline AT9's invite-only refusal and
// the desktop's loopback callback both already apply. NotFoundError is
// what every one of these services already throws for a genuinely
// missing row (see docs.service.ts's updateDoc, views.service.ts's
// updateView) — this reuses that exact mapping rather than inventing a
// second "not found" shape.

/** Throws NotFoundError('project') unless `projectId` belongs to the
 * current request's workspace (Personal's WORKSPACE_ID fallback when
 * unauthenticated). Call this first, before touching any row that
 * hangs off the project, in every function that takes a projectId. */
export async function assertProjectInWorkspace(projectId: string): Promise<void> {
  const [row] = await db.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, projectId));
  if (!row || row.workspaceId !== currentWorkspaceId()) {
    throw new NotFoundError('project');
  }
}

/** Throws NotFoundError('ticket') unless `ticketId` belongs to the
 * current request's workspace, via its project. AT11 review fix: for
 * comments.service.ts and activity.service.ts, called directly from
 * routes with a bare req.params.id — they don't inherit scoping from an
 * already-guarded caller the way tickets.service.ts's own logActivity
 * callers (already inside a workspace-checked transaction) do. */
export async function assertTicketInWorkspace(ticketId: string): Promise<void> {
  const [row] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), inArray(tickets.projectId, workspaceProjectIdsSubquery())));
  if (!row) throw new NotFoundError('ticket');
}

/** A Drizzle subquery of every project id in the caller's current
 * workspace — for the id-keyed update/delete functions where adding the
 * check straight into the mutating query's own WHERE clause (one atomic
 * statement, no separate read) is cleaner than fetch-then-assert. Pass
 * as one operand of an `and(...)` alongside the row's own id/table
 * columns; a cross-tenant id then simply matches zero rows, and every
 * one of these functions already treats zero rows as NotFoundError. */
export function workspaceProjectIdsSubquery() {
  return db.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, currentWorkspaceId()));
}
