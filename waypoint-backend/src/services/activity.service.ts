import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityEntries } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Shared by workItems.service.ts and comments.service.ts so every mutation
// that should leave a trail logs through the same insert, inside whatever
// transaction the caller is already in.
export async function logActivity(
  tx: Tx,
  entry: { workItemId: string; actorId: string; verb: string; detail: string; createdAt?: Date },
) {
  await tx.insert(activityEntries).values({
    id: newId('act'),
    workItemId: entry.workItemId,
    actorId: entry.actorId,
    verb: entry.verb,
    detail: entry.detail,
    createdAt: entry.createdAt ?? new Date(),
  });
}

export async function listActivity(workItemId: string) {
  return db
    .select()
    .from(activityEntries)
    .where(eq(activityEntries.workItemId, workItemId))
    .orderBy(asc(activityEntries.createdAt));
}
