import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { webhooks } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { currentWorkspaceId } from '../lib/requestContext.js';

// AT11 (ROAD-146) sixth review round: this file was on the audit's own
// "deferred, lower severity" list, until the review proved that claim
// false — listWebhooks had no WHERE clause at all (every tenant's
// webhook rows, including their delivery URLs, which routinely carry a
// shared secret in the path or query), and deleteWebhook took a bare id
// with no scoping (a real, destructive, zero-setup cross-tenant write —
// exactly the severity bar the deferral argument claimed nothing here
// met). createWebhook already wrote the pre-AT11 WORKSPACE_ID constant
// directly, never touched by the earlier identity-constant swap.
export async function listWebhooks() {
  return db
    .select()
    .from(webhooks)
    .where(eq(webhooks.workspaceId, currentWorkspaceId()))
    .orderBy(desc(webhooks.createdAt));
}

export async function createWebhook(input: { url: string; eventTypes: string[] }) {
  const [row] = await db
    .insert(webhooks)
    .values({ id: newId('wh'), workspaceId: currentWorkspaceId(), url: input.url, eventTypes: input.eventTypes, enabled: true })
    .returning();
  return row;
}

export async function deleteWebhook(id: string) {
  await db.delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.workspaceId, currentWorkspaceId())));
}
