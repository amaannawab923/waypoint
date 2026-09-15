import { eq, desc } from 'drizzle-orm';
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

export async function markNotificationRead(id: string) {
  await db.update(notifications).set({ read: true }).where(eq(notifications.id, id));
}
