import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { members } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID, WORKSPACE_ID } from '../lib/currentUser.js';

export async function getCurrentUser() {
  const [row] = await db.select().from(members).where(eq(members.id, CURRENT_USER_ID));
  if (!row) throw new NotFoundError('current user');
  return row;
}

export async function updateCurrentUser(patch: { fullName?: string; displayName?: string; email?: string }) {
  const [row] = await db.update(members).set(patch).where(eq(members.id, CURRENT_USER_ID)).returning();
  if (!row) throw new NotFoundError('current user');
  return row;
}

export async function listMembers() {
  return db.select().from(members);
}

export async function inviteMember(input: { email: string; role: 'admin' | 'member' | 'guest' }) {
  const localPart = input.email.split('@')[0];
  const [row] = await db
    .insert(members)
    .values({
      id: newId('mem'),
      workspaceId: WORKSPACE_ID,
      fullName: localPart,
      displayName: localPart,
      email: input.email,
      avatarColor: '#9c9280',
      role: input.role,
      authMethod: 'email',
    })
    .returning();
  return row;
}
