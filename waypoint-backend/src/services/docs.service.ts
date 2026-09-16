import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { docs } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { and, inArray } from 'drizzle-orm';
import { newId } from '../lib/ids.js';
import { currentMemberId } from '../lib/requestContext.js';
import { assertProjectInWorkspace, workspaceProjectIdsSubquery } from '../lib/workspaceGuard.js';

export async function listDocs(projectId: string) {
  await assertProjectInWorkspace(projectId);
  return db.select().from(docs).where(eq(docs.projectId, projectId));
}

// AT11 (ROAD-146): scoped to the caller's workspace via its projects —
// docs has no workspaceId column of its own.
export async function listAllDocs() {
  return db.select().from(docs).where(inArray(docs.projectId, workspaceProjectIdsSubquery()));
}

export async function getDoc(id: string) {
  const [row] = await db
    .select()
    .from(docs)
    .where(and(eq(docs.id, id), inArray(docs.projectId, workspaceProjectIdsSubquery())));
  return row;
}

// Eighth review round, proven live: parentDocId was written unchecked —
// a real row parented under another workspace's real doc.
async function assertDocInWorkspace(id: string): Promise<void> {
  const [row] = await db
    .select({ id: docs.id })
    .from(docs)
    .where(and(eq(docs.id, id), inArray(docs.projectId, workspaceProjectIdsSubquery())));
  if (!row) throw new NotFoundError('doc');
}

export async function createDoc(projectId: string, title = 'Untitled', parentDocId: string | null = null) {
  await assertProjectInWorkspace(projectId);
  if (parentDocId) await assertDocInWorkspace(parentDocId);
  const [row] = await db
    .insert(docs)
    .values({
      // Opaque row-id prefix, deliberately unchanged — same call C2 made
      // when it left newId('wi') in place for tickets.
      id: newId('pg'),
      projectId,
      title,
      icon: '📄',
      contentHtml: '<p></p>',
      visibility: 'private',
      ownerId: currentMemberId(),
      isFavorite: false,
      isLocked: false,
      parentDocId,
    })
    .returning();
  return row;
}

export async function updateDoc(id: string, patch: Partial<typeof docs.$inferInsert>) {
  if (patch.parentDocId) await assertDocInWorkspace(patch.parentDocId);
  const [row] = await db
    .update(docs)
    .set({ ...patch, updatedAt: new Date() })
    // AT11 (ROAD-146): one atomic statement — a cross-tenant id matches
    // zero rows, which the existing NotFoundError below already covers.
    .where(and(eq(docs.id, id), inArray(docs.projectId, workspaceProjectIdsSubquery())))
    .returning();
  if (!row) throw new NotFoundError('doc');
  return row;
}

// Re-parents direct children to the deleted doc's own parent rather than
// cascading the delete through the whole subtree, same as the mock.
export async function deleteDoc(id: string) {
  return db.transaction(async (tx) => {
    // AT11 (ROAD-146): scoped read — a cross-tenant id resolves `doc` to
    // undefined here, same as a genuinely missing one, and the early
    // return below then leaves both statements unrun rather than
    // reaching them unscoped by workspace.
    const [doc] = await tx
      .select()
      .from(docs)
      .where(and(eq(docs.id, id), inArray(docs.projectId, workspaceProjectIdsSubquery())));
    if (!doc) return;
    await tx.update(docs).set({ parentDocId: doc.parentDocId }).where(eq(docs.parentDocId, id));
    await tx.delete(docs).where(eq(docs.id, id));
  });
}
