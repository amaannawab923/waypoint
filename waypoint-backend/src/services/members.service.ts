import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { members } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';

export async function getCurrentUser() {
  const [row] = await db.select().from(members).where(eq(members.id, currentMemberId()));
  if (!row) throw new NotFoundError('current user');
  return row;
}

export async function updateCurrentUser(patch: {
  fullName?: string;
  displayName?: string;
  email?: string;
  firstDayOfWeek?: string;
  notificationPrefs?: Record<string, boolean>;
}) {
  // notificationPrefs is a partial toggle patch (one row's Switch flips one
  // key at a time), so it merges into whatever's already stored rather than
  // replacing it — the same convention projects.service.ts's
  // updateProjectAutomations uses for its own jsonb column. Every other
  // field on this patch is a plain column, so .set() overwrites those as
  // normal.
  if (!patch.notificationPrefs) {
    const [row] = await db.update(members).set(patch).where(eq(members.id, currentMemberId())).returning();
    if (!row) throw new NotFoundError('current user');
    return row;
  }
  const [current] = await db.select().from(members).where(eq(members.id, currentMemberId()));
  if (!current) throw new NotFoundError('current user');
  const mergedPrefs = { ...(current.notificationPrefs as object), ...patch.notificationPrefs };
  const [row] = await db
    .update(members)
    .set({ ...patch, notificationPrefs: mergedPrefs })
    .where(eq(members.id, currentMemberId()))
    .returning();
  if (!row) throw new NotFoundError('current user');
  return row;
}

// AT11 (ROAD-146): the confirmed live leak. This ran with no WHERE clause
// at all — every member row in the entire database, across every
// workspace, to any caller. Latent only because exactly one workspace
// existed before this epic; exploitable the instant a second one does.
export async function listMembers() {
  return db.select().from(members).where(eq(members.workspaceId, currentWorkspaceId()));
}

export async function inviteMember(input: { email: string; role: 'admin' | 'member' | 'guest' }) {
  const localPart = input.email.split('@')[0];
  const [row] = await db
    .insert(members)
    .values({
      id: newId('mem'),
      workspaceId: currentWorkspaceId(),
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
