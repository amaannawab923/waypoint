import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pages } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';

export async function listPages(projectId: string) {
  return db.select().from(pages).where(eq(pages.projectId, projectId));
}

export async function listAllPages() {
  return db.select().from(pages);
}

export async function getPage(id: string) {
  const [row] = await db.select().from(pages).where(eq(pages.id, id));
  return row;
}

export async function createPage(projectId: string, title = 'Untitled', parentPageId: string | null = null) {
  const [row] = await db
    .insert(pages)
    .values({
      id: newId('pg'),
      projectId,
      title,
      icon: '📄',
      contentHtml: '<p></p>',
      visibility: 'private',
      ownerId: CURRENT_USER_ID,
      isFavorite: false,
      isLocked: false,
      parentPageId,
    })
    .returning();
  return row;
}

export async function updatePage(id: string, patch: Partial<typeof pages.$inferInsert>) {
  const [row] = await db
    .update(pages)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pages.id, id))
    .returning();
  if (!row) throw new NotFoundError('page');
  return row;
}

// Re-parents direct children to the deleted page's own parent rather than
// cascading the delete through the whole subtree, same as the mock.
export async function deletePage(id: string) {
  return db.transaction(async (tx) => {
    const [page] = await tx.select().from(pages).where(eq(pages.id, id));
    const parentPageId = page?.parentPageId ?? null;
    await tx.update(pages).set({ parentPageId }).where(eq(pages.parentPageId, id));
    await tx.delete(pages).where(eq(pages.id, id));
  });
}
