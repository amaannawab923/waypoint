import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema/index.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';

export async function listNotifications() {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientId, CURRENT_USER_ID))
    .orderBy(desc(notifications.createdAt));
}

export async function markNotificationRead(id: string) {
  await db.update(notifications).set({ read: true }).where(eq(notifications.id, id));
}
