import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { docs } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';

export async function listDocs(projectId: string) {
  return db.select().from(docs).where(eq(docs.projectId, projectId));
}

export async function listAllDocs() {
  return db.select().from(docs);
}

export async function getDoc(id: string) {
  const [row] = await db.select().from(docs).where(eq(docs.id, id));
  return row;
}

export async function createDoc(projectId: string, title = 'Untitled', parentDocId: string | null = null) {
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
      ownerId: CURRENT_USER_ID,
      isFavorite: false,
      isLocked: false,
      parentDocId,
    })
    .returning();
  return row;
}

export async function updateDoc(id: string, patch: Partial<typeof docs.$inferInsert>) {
  const [row] = await db
    .update(docs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(docs.id, id))
    .returning();
  if (!row) throw new NotFoundError('doc');
  return row;
}

// Re-parents direct children to the deleted doc's own parent rather than
// cascading the delete through the whole subtree, same as the mock.
export async function deleteDoc(id: string) {
  return db.transaction(async (tx) => {
    const [doc] = await tx.select().from(docs).where(eq(docs.id, id));
    const parentDocId = doc?.parentDocId ?? null;
    await tx.update(docs).set({ parentDocId }).where(eq(docs.parentDocId, id));
    await tx.delete(docs).where(eq(docs.id, id));
  });
}
