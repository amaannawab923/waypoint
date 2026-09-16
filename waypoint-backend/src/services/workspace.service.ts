import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaces } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { currentWorkspaceId } from '../lib/requestContext.js';

// AT11 (ROAD-146) seventh review round: this file was never touched by
// the audit at all — every call read and wrote the pre-AT11 WORKSPACE_ID
// constant directly, so GET /workspace and PATCH /workspace always
// operated on Personal's own row ('ws-1') regardless of which hosted
// tenant was actually signed in. Beyond leaking another workspace's
// name/plan/security settings to any caller, PATCH was a real,
// destructive, zero-setup cross-tenant write — renaming or reassigning
// the plan on a workspace you don't belong to — and, the other half of
// the same bug, no hosted tenant could ever read or rename their OWN
// workspace at all.
export async function getWorkspace() {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, currentWorkspaceId()));
  if (!row) throw new NotFoundError('workspace');
  return row;
}

export async function updateWorkspace(patch: Partial<typeof workspaces.$inferInsert>) {
  const [row] = await db
    .update(workspaces)
    .set(patch)
    .where(eq(workspaces.id, currentWorkspaceId()))
    .returning();
  if (!row) throw new NotFoundError('workspace');
  return row;
}
