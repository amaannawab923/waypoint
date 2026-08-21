import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { stickies } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';

const COLORS = ['#c2542a', '#2f6fa8', '#2f7a4f', '#a5780c'];

export async function listStickies() {
  return db.select().from(stickies).where(eq(stickies.authorId, CURRENT_USER_ID));
}

export async function createSticky(title: string, body: string) {
  const [row] = await db
    .insert(stickies)
    .values({
      id: newId('sk'),
      authorId: CURRENT_USER_ID,
      title,
      body,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    })
    .returning();
  return row;
}

export async function deleteSticky(id: string) {
  await db.delete(stickies).where(eq(stickies.id, id));
}
