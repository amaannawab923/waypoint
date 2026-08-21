import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { labels } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';

export async function listLabels(projectId: string) {
  return db.select().from(labels).where(eq(labels.projectId, projectId));
}

export async function createLabel(projectId: string, input: { name: string; color: string }) {
  const [row] = await db
    .insert(labels)
    .values({ id: newId('lbl'), projectId, name: input.name, color: input.color })
    .returning();
  return row;
}

export async function updateLabel(id: string, patch: Partial<typeof labels.$inferInsert>) {
  const [row] = await db.update(labels).set(patch).where(eq(labels.id, id)).returning();
  if (!row) throw new NotFoundError('label');
  return row;
}

export async function deleteLabel(id: string) {
  await db.delete(labels).where(eq(labels.id, id));
}
