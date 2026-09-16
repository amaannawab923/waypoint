import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { savedViews } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { currentMemberId } from '../lib/requestContext.js';
import { assertProjectInWorkspace, workspaceProjectIdsSubquery } from '../lib/workspaceGuard.js';
import type { TicketFilterQuery } from '../validation/ticketFilter.schema.js';

export async function listViews(projectId: string) {
  await assertProjectInWorkspace(projectId);
  return db.select().from(savedViews).where(eq(savedViews.projectId, projectId));
}

export async function createView(projectId: string, name: string, filters: TicketFilterQuery) {
  await assertProjectInWorkspace(projectId);
  const [row] = await db
    .insert(savedViews)
    .values({ id: newId('view'), projectId, name, ownerId: currentMemberId(), filters, visibility: 'public', isFavorite: false })
    .returning();
  return row;
}

// AT11 (ROAD-146): savedViews.projectId is nullable (a workspace-wide
// view, per the schema's own §4.6 comment). The inArray(...) filter
// below only matches a real projectId — no function in this file ever
// creates a null-projectId row (createView always sets a real one), so
// this is a real, current gap only if something else starts creating
// those; flagged rather than silently assumed away.
export async function updateView(id: string, patch: Partial<typeof savedViews.$inferInsert>) {
  const [row] = await db
    .update(savedViews)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(savedViews.id, id), inArray(savedViews.projectId, workspaceProjectIdsSubquery())))
    .returning();
  if (!row) throw new NotFoundError('view');
  return row;
}

export async function deleteView(id: string) {
  await db
    .delete(savedViews)
    .where(and(eq(savedViews.id, id), inArray(savedViews.projectId, workspaceProjectIdsSubquery())));
}
