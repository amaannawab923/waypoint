import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { webhooks } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { WORKSPACE_ID } from '../lib/currentUser.js';

export async function listWebhooks() {
  return db.select().from(webhooks).orderBy(desc(webhooks.createdAt));
}

export async function createWebhook(input: { url: string; eventTypes: string[] }) {
  const [row] = await db
    .insert(webhooks)
    .values({ id: newId('wh'), workspaceId: WORKSPACE_ID, url: input.url, eventTypes: input.eventTypes, enabled: true })
    .returning();
  return row;
}

export async function deleteWebhook(id: string) {
  await db.delete(webhooks).where(eq(webhooks.id, id));
}
