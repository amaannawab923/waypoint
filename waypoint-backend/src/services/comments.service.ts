import { eq, and, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { currentMemberId } from '../lib/requestContext.js';
import { assertTicketInWorkspace } from '../lib/workspaceGuard.js';
import { logActivity } from './activity.service.js';

// limit caps how many rows the query itself fetches (undefined means
// unlimited, preserving prior behavior for callers that don't pass one —
// see the REST route in tickets.routes.ts). Ordered by createdAt so a
// limited call has a deterministic, meaningful "first N" rather than
// whatever order the table scan happens to return.
// AT11 (ROAD-146) review fix: called directly from routes/tickets.routes.ts
// with a bare req.params.id — this file's own boundary, not one that
// inherits scoping from an already-guarded caller the way logActivity's
// tx-scoped callers do.
export async function listComments(ticketId: string, limit?: number) {
  await assertTicketInWorkspace(ticketId);
  const query = db
    .select()
    .from(comments)
    .where(eq(comments.ticketId, ticketId))
    .orderBy(asc(comments.createdAt));
  return limit ? query.limit(limit) : query;
}

export async function addComment(
  ticketId: string,
  bodyHtml: string,
  /** The activity line; the default is a person's own comment. */
  activityDetail = 'left a comment',
) {
  await assertTicketInWorkspace(ticketId);
  return db.transaction(async (tx) => {
    const [comment] = await tx
      .insert(comments)
      .values({ id: newId('cm'), ticketId, authorId: currentMemberId(), bodyHtml })
      .returning();
    await logActivity(tx, {
      ticketId,
      actorId: currentMemberId(),
      verb: 'commented',
      detail: activityDetail,
      createdAt: comment.createdAt,
    });
    return comment;
  });
}
