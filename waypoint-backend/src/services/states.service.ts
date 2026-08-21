import { eq, asc, count } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workItemStates, workItems } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';

export async function listStates(projectId: string) {
  return db
    .select()
    .from(workItemStates)
    .where(eq(workItemStates.projectId, projectId))
    .orderBy(asc(workItemStates.sortOrder));
}

export async function createState(
  projectId: string,
  input: { name: string; group: (typeof workItemStates.$inferInsert)['group']; color: string },
) {
  const existing = await listStates(projectId);
  const [row] = await db
    .insert(workItemStates)
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

export async function updateState(id: string, patch: Partial<typeof workItemStates.$inferInsert>) {
  const [row] = await db.update(workItemStates).set(patch).where(eq(workItemStates.id, id)).returning();
  if (!row) throw new NotFoundError('state');
  return row;
}

export async function countWorkItemsInState(stateId: string) {
  const [row] = await db.select({ n: count() }).from(workItems).where(eq(workItems.stateId, stateId));
  return row?.n ?? 0;
}

export async function deleteState(id: string) {
  await db.delete(workItemStates).where(eq(workItemStates.id, id));
}
