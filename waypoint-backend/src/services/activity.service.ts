import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityEntries } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Shared by tickets.service.ts and comments.service.ts so every mutation
// that should leave a trail logs through the same insert, inside whatever
// transaction the caller is already in.
export async function logActivity(
  tx: Tx,
  entry: { ticketId: string; actorId: string; verb: string; detail: string; createdAt?: Date },
) {
  await tx.insert(activityEntries).values({
    id: newId('act'),
    ticketId: entry.ticketId,
    actorId: entry.actorId,
    verb: entry.verb,
    detail: entry.detail,
    createdAt: entry.createdAt ?? new Date(),
  });
}

// limit caps how many rows the query itself fetches (undefined means
// unlimited, preserving prior behavior for callers that don't pass one —
// see the REST route in tickets.routes.ts).
export async function listActivity(ticketId: string, limit?: number) {
  const query = db
    .select()
    .from(activityEntries)
    .where(eq(activityEntries.ticketId, ticketId))
    .orderBy(asc(activityEntries.createdAt));
  return limit ? query.limit(limit) : query;
}
