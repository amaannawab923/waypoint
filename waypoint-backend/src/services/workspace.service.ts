import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaces } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { WORKSPACE_ID } from '../lib/currentUser.js';

export async function getWorkspace() {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, WORKSPACE_ID));
  if (!row) throw new NotFoundError('workspace');
  return row;
}

export async function updateWorkspace(patch: Partial<typeof workspaces.$inferInsert>) {
  const [row] = await db
    .update(workspaces)
    .set(patch)
    .where(eq(workspaces.id, WORKSPACE_ID))
    .returning();
  if (!row) throw new NotFoundError('workspace');
  return row;
}
