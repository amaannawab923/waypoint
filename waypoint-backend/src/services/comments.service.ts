import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';
import { logActivity } from './activity.service.js';

export async function listComments(workItemId: string) {
  return db.select().from(comments).where(eq(comments.workItemId, workItemId));
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
