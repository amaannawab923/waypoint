import { desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaceExports } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { WORKSPACE_ID } from '../lib/currentUser.js';

export async function listExports() {
  return db.select().from(workspaceExports).orderBy(desc(workspaceExports.createdAt));
}

export async function createExport(input: { scopeLabel: string; format: string }) {
  const [row] = await db
    .insert(workspaceExports)
    .values({ id: newId('exp'), workspaceId: WORKSPACE_ID, scopeLabel: input.scopeLabel, format: input.format, status: 'completed' })
    .returning();
  return row;
}
