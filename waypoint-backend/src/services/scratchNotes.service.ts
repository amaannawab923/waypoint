import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scratchNotes } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';

const COLORS = ['#c2542a', '#2f6fa8', '#2f7a4f', '#a5780c'];

// AT11 (ROAD-146): both conditions, not just authorId — the explicit
// defense-in-depth the workspace-scoping audit specifically asked for
// here, on top of what authorId's own (person, workspace) uniqueness
// already made implicitly true.
export async function listScratchNotes() {
  return db
    .select()
    .from(scratchNotes)
    .where(and(eq(scratchNotes.authorId, currentMemberId()), eq(scratchNotes.workspaceId, currentWorkspaceId())));
}

export async function createScratchNote(title: string, body: string) {
  const [row] = await db
    .insert(scratchNotes)
    .values({
      // Opaque row-id prefix, deliberately unchanged — same call C2 made
      // when it left newId('wi') in place for tickets.
      id: newId('sk'),
      authorId: currentMemberId(),
      workspaceId: currentWorkspaceId(),
      title,
      body,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    })
    .returning();
  return row;
}

// Tenth review round: scoped by authorId too, matching listScratchNotes —
// previously any teammate in the same workspace could delete another
// member's own scratch note by id. Intra-workspace, not cross-tenant, but
// there's no reason the read and the delete should disagree.
export async function deleteScratchNote(id: string) {
  await db
    .delete(scratchNotes)
    .where(
      and(
        eq(scratchNotes.id, id),
        eq(scratchNotes.authorId, currentMemberId()),
        eq(scratchNotes.workspaceId, currentWorkspaceId()),
      ),
    );
}
