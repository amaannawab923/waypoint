import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { labels } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { assertProjectInWorkspace, workspaceProjectIdsSubquery } from '../lib/workspaceGuard.js';

// AT11 (ROAD-146) seventh review round: entirely unaudited — listLabels/
// createLabel took a bare projectId with no check, and updateLabel/
// deleteLabel a bare id, all with no workspace scoping at all. Proven
// live: a real cross-tenant delete, a real cross-tenant rename, and real
// rows written into another workspace's project.
export async function listLabels(projectId: string) {
  await assertProjectInWorkspace(projectId);
  return db.select().from(labels).where(eq(labels.projectId, projectId));
}

export async function createLabel(projectId: string, input: { name: string; color: string }) {
  await assertProjectInWorkspace(projectId);
  const [row] = await db
    .insert(labels)
    .values({ id: newId('lbl'), projectId, name: input.name, color: input.color })
    .returning();
  return row;
}

export async function updateLabel(id: string, patch: Partial<typeof labels.$inferInsert>) {
  const [row] = await db
    .update(labels)
    .set(patch)
    .where(and(eq(labels.id, id), inArray(labels.projectId, workspaceProjectIdsSubquery())))
    .returning();
  if (!row) throw new NotFoundError('label');
  return row;
}

export async function deleteLabel(id: string) {
  await db.delete(labels).where(and(eq(labels.id, id), inArray(labels.projectId, workspaceProjectIdsSubquery())));
}
