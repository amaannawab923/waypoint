import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaceExports } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { currentWorkspaceId } from '../lib/requestContext.js';

// AT11 (ROAD-146) sixth review round: listExports had no WHERE clause at
// all — every tenant's export history to any caller — and createExport
// wrote the pre-AT11 WORKSPACE_ID constant directly, so a hosted
// tenant's own export would have landed in Personal's workspace instead
// of theirs.
export async function listExports() {
  return db
    .select()
    .from(workspaceExports)
    .where(eq(workspaceExports.workspaceId, currentWorkspaceId()))
    .orderBy(desc(workspaceExports.createdAt));
}

export async function createExport(input: { scopeLabel: string; format: string }) {
  const [row] = await db
    .insert(workspaceExports)
    .values({ id: newId('exp'), workspaceId: currentWorkspaceId(), scopeLabel: input.scopeLabel, format: input.format, status: 'completed' })
    .returning();
  return row;
}
