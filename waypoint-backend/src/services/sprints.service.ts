import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sprints, sprintMembers } from '../db/schema/index.js';
import { NotFoundError, ConflictError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';

async function attachMemberIds<T extends { id: string }>(rows: T[]): Promise<(T & { memberIds: string[] })[]> {
  if (rows.length === 0) return [];
  const links = await db
    .select()
    .from(sprintMembers)
    .where(inArray(sprintMembers.sprintId, rows.map((r) => r.id)));
  const bySprint = new Map<string, string[]>();
  for (const l of links) bySprint.set(l.sprintId, [...(bySprint.get(l.sprintId) ?? []), l.memberId]);
  return rows.map((r) => ({ ...r, memberIds: bySprint.get(r.id) ?? [] }));
}

export async function listSprints(projectId: string) {
  const rows = await db.select().from(sprints).where(eq(sprints.projectId, projectId));
  return attachMemberIds(rows);
}

export async function listAllSprints() {
  const rows = await db.select().from(sprints);
  return attachMemberIds(rows);
}

export interface CreateSprintInput {
  name: string;
  description?: string;
  startDate: string;
  endDate: string;
  leadId?: string;
  memberIds?: string[];
}

export async function createSprint(projectId: string, input: CreateSprintInput) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sprints)
      .values({
        // Opaque row-id prefix, deliberately unchanged — same call C2 made
        // when it left newId('wi') in place for tickets.
        id: newId('cyc'),
        projectId,
        name: input.name,
        description: input.description ?? '',
        startDate: input.startDate,
        endDate: input.endDate,
        leadId: input.leadId ?? null,
      })
      .returning();
    if (input.memberIds?.length) {
      await tx.insert(sprintMembers).values(input.memberIds.map((memberId) => ({ sprintId: row.id, memberId })));
    }
    return { ...row, memberIds: input.memberIds ?? [] };
  });
}

export async function updateSprint(id: string, patch: Partial<CreateSprintInput>) {
  return db.transaction(async (tx) => {
    const { memberIds, ...rest } = patch;

    // The schema only checks endDate >= startDate when a patch supplies
    // both together (see validation/workstreamsSprints.schema.ts) — it has
    // no way to see the currently-stored value of whichever date field is
    // NOT in this patch. Check that case here, where the stored row is
    // actually available, so a single-field date PATCH can't produce an
    // inverted range that a two-field PATCH would have rejected.
    if (rest.startDate !== undefined || rest.endDate !== undefined) {
      const [current] = await tx.select().from(sprints).where(eq(sprints.id, id));
      if (!current) throw new NotFoundError('sprint');
      const nextStart = rest.startDate ?? current.startDate;
      const nextEnd = rest.endDate ?? current.endDate;
      if (nextEnd < nextStart) {
        throw new ConflictError('endDate must not be before startDate');
      }
    }

    // See workstreams.service.ts's updateWorkstream — a memberIds-only patch
    // leaves `rest` empty, and `.set({})` is invalid SQL.
    const row = Object.keys(rest).length
      ? (await tx.update(sprints).set(rest).where(eq(sprints.id, id)).returning())[0]
      : (await tx.select().from(sprints).where(eq(sprints.id, id)))[0];
    if (!row) throw new NotFoundError('sprint');
    if (memberIds) {
      await tx.delete(sprintMembers).where(eq(sprintMembers.sprintId, id));
      if (memberIds.length) {
        await tx.insert(sprintMembers).values(memberIds.map((memberId) => ({ sprintId: id, memberId })));
      }
    }
    const finalMemberIds = memberIds ?? (await tx.select().from(sprintMembers).where(eq(sprintMembers.sprintId, id))).map((m) => m.memberId);
    return { ...row, memberIds: finalMemberIds };
  });
}

export async function deleteSprint(id: string) {
  await db.delete(sprints).where(eq(sprints.id, id));
}
