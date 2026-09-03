import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scratchNotes } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';

const COLORS = ['#c2542a', '#2f6fa8', '#2f7a4f', '#a5780c'];

export async function listScratchNotes() {
  return db.select().from(scratchNotes).where(eq(scratchNotes.authorId, CURRENT_USER_ID));
}

export async function createScratchNote(title: string, body: string) {
  const [row] = await db
    .insert(scratchNotes)
    .values({
      // Opaque row-id prefix, deliberately unchanged — same call C2 made
      // when it left newId('wi') in place for tickets.
      id: newId('sk'),
      authorId: CURRENT_USER_ID,
      title,
      body,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    })
    .returning();
  return row;
}

export async function deleteScratchNote(id: string) {
  await db.delete(scratchNotes).where(eq(scratchNotes.id, id));
}
