import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';
import { logActivity } from './activity.service.js';

// limit caps how many rows the query itself fetches (undefined means
// unlimited, preserving prior behavior for callers that don't pass one —
// see the REST route in workItems.routes.ts). Ordered by createdAt so a
// limited call has a deterministic, meaningful "first N" rather than
// whatever order the table scan happens to return.
export async function listComments(workItemId: string, limit?: number) {
  const query = db
    .select()
    .from(comments)
    .where(eq(comments.workItemId, workItemId))
    .orderBy(asc(comments.createdAt));
  return limit ? query.limit(limit) : query;
}

export async function addComment(workItemId: string, bodyHtml: string) {
  return db.transaction(async (tx) => {
    const [comment] = await tx
      .insert(comments)
      .values({ id: newId('cm'), workItemId, authorId: CURRENT_USER_ID, bodyHtml })
      .returning();
    await logActivity(tx, {
      workItemId,
      actorId: CURRENT_USER_ID,
      verb: 'commented',
      detail: 'left a comment',
      createdAt: comment.createdAt,
    });
    return comment;
  });
}
