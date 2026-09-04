import { eq, asc, count, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ticketStates, tickets } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';

export async function listStates(projectId: string) {
  return db
    .select()
    .from(ticketStates)
    .where(eq(ticketStates.projectId, projectId))
    .orderBy(asc(ticketStates.sortOrder));
}

// Batched sibling of listStates for callers that only have a scattered set
// of stateIds (e.g. Copilot's MCP ticket summaries) and no single
// projectId to list from — one query for every distinct id, not one query
// per row. Mirrors lib/actorNames.ts's resolveActorNames: same batching
// shape, same "id -> display info" purpose, different table.
export async function resolveStateNames(ids: string[]): Promise<Map<string, { name: string; group: string }>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map();
  const rows = await db
    .select({ id: ticketStates.id, name: ticketStates.name, group: ticketStates.group })
    .from(ticketStates)
    .where(inArray(ticketStates.id, uniqueIds));
  return new Map(rows.map((row) => [row.id, { name: row.name, group: row.group }]));
}

export async function createState(
  projectId: string,
  input: { name: string; group: (typeof ticketStates.$inferInsert)['group']; color: string },
) {
  const existing = await listStates(projectId);
  const [row] = await db
    .insert(ticketStates)
    .values({
      id: newId('st'),
      projectId,
      name: input.name,
      group: input.group,
      color: input.color,
      isDefault: false,
      sortOrder: existing.length,
    })
    .returning();
  return row;
}

export async function updateState(id: string, patch: Partial<typeof ticketStates.$inferInsert>) {
  const [row] = await db.update(ticketStates).set(patch).where(eq(ticketStates.id, id)).returning();
  if (!row) throw new NotFoundError('state');
  return row;
}

export async function countTicketsInState(stateId: string) {
  const [row] = await db.select({ n: count() }).from(tickets).where(eq(tickets.stateId, stateId));
  return row?.n ?? 0;
}

export async function deleteState(id: string) {
  await db.delete(ticketStates).where(eq(ticketStates.id, id));
}
