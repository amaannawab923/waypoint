import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { savedViews } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';

export async function listViews(projectId: string) {
  return db.select().from(savedViews).where(eq(savedViews.projectId, projectId));
}

export async function createView(projectId: string, name: string, filters: Record<string, unknown>) {
  const [row] = await db
    .insert(savedViews)
    .values({ id: newId('view'), projectId, name, ownerId: CURRENT_USER_ID, filters, visibility: 'public', isFavorite: false })
    .returning();
  return row;
}

export async function updateView(id: string, patch: Partial<typeof savedViews.$inferInsert>) {
  const [row] = await db
    .update(savedViews)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(savedViews.id, id))
    .returning();
  if (!row) throw new NotFoundError('view');
  return row;
}

export async function deleteView(id: string) {
  await db.delete(savedViews).where(eq(savedViews.id, id));
}
