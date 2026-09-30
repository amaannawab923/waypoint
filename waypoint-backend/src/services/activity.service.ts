import { eq, asc, sql } from 'drizzle-orm';
import { assertTicketInWorkspace } from '../lib/workspaceGuard.js';
import { db } from '../db/client.js';
import { activityEntries, ticketStates } from '../db/schema/index.js';
import type { ActivityPayload, ActivityStateSnapshot } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Shared by tickets.service.ts and comments.service.ts so every mutation
// that should leave a trail logs through the same insert, inside whatever
// transaction the caller is already in.
export async function logActivity(
  tx: Tx,
  entry: {
    ticketId: string;
    actorId: string;
    verb: string;
    detail: string;
    /** What changed, structured (see ActivityPayload). */
    payload?: ActivityPayload;
    createdAt?: Date;
  },
) {
  await tx.insert(activityEntries).values({
    id: newId('act'),
    ticketId: entry.ticketId,
    actorId: entry.actorId,
    verb: entry.verb,
    detail: entry.detail,
    payload: entry.payload ?? {},
    // The transaction's own timestamp by default, so every change made in
    // one save shares one instant and the page can show them as one save in
    // a sensible order (a per-insert clock scattered them by milliseconds).
    createdAt: entry.createdAt ?? sql`now()`,
  });
}

/** A state as it is right now, for an entry's before/after snapshot. */
export async function stateSnapshot(tx: Tx, stateId: string | null | undefined): Promise<ActivityStateSnapshot | null> {
  if (!stateId) return null;
  const [s] = await tx
    .select({ id: ticketStates.id, name: ticketStates.name, group: ticketStates.group, color: ticketStates.color })
    .from(ticketStates)
    .where(eq(ticketStates.id, stateId));
  return s ?? null;
}

// limit caps how many rows the query itself fetches (undefined means
// unlimited, preserving prior behavior for callers that don't pass one —
// see the REST route in tickets.routes.ts).
// AT11 (ROAD-146) review fix: called directly from routes/tickets.routes.ts
// with a bare req.params.id.
export async function listActivity(ticketId: string, limit?: number) {
  await assertTicketInWorkspace(ticketId);
  const query = db
    .select()
    .from(activityEntries)
    .where(eq(activityEntries.ticketId, ticketId))
    // id breaks ties between entries written in one save (same now()).
    .orderBy(asc(activityEntries.createdAt), asc(activityEntries.id));
  return limit ? query.limit(limit) : query;
}
