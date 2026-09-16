import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema/index.js';
import { currentMemberId } from '../lib/requestContext.js';

export async function listNotifications() {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientId, currentMemberId()))
    .orderBy(desc(notifications.createdAt));
}

// AT11 (ROAD-146) sixth review round: took a bare id with no recipient
// check — any signed-in member could mark another member's notification
// read, matching listNotifications' own scoping instead of leaving it
// unscoped.
export async function markNotificationRead(id: string) {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, id), eq(notifications.recipientId, currentMemberId())));
}
