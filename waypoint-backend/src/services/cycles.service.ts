import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cycles, cycleMembers } from '../db/schema/index.js';
import { NotFoundError, ConflictError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';

async function attachMemberIds<T extends { id: string }>(rows: T[]): Promise<(T & { memberIds: string[] })[]> {
  if (rows.length === 0) return [];
  const links = await db
    .select()
    .from(cycleMembers)
    .where(inArray(cycleMembers.cycleId, rows.map((r) => r.id)));
  const byCycle = new Map<string, string[]>();
  for (const l of links) byCycle.set(l.cycleId, [...(byCycle.get(l.cycleId) ?? []), l.memberId]);
  return rows.map((r) => ({ ...r, memberIds: byCycle.get(r.id) ?? [] }));
}

export async function listCycles(projectId: string) {
  const rows = await db.select().from(cycles).where(eq(cycles.projectId, projectId));
  return attachMemberIds(rows);
}

export async function listAllCycles() {
  const rows = await db.select().from(cycles);
  return attachMemberIds(rows);
}

export interface CreateCycleInput {
  name: string;
  description?: string;
  startDate: string;
  endDate: string;
  leadId?: string;
  memberIds?: string[];
}

export async function createCycle(projectId: string, input: CreateCycleInput) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(cycles)
      .values({
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
      await tx.insert(cycleMembers).values(input.memberIds.map((memberId) => ({ cycleId: row.id, memberId })));
    }
    return { ...row, memberIds: input.memberIds ?? [] };
  });
}

export async function updateCycle(id: string, patch: Partial<CreateCycleInput>) {
  return db.transaction(async (tx) => {
    const { memberIds, ...rest } = patch;

    // The schema only checks endDate >= startDate when a patch supplies
    // both together (see validation/modulesCycles.schema.ts) — it has no
    // way to see the currently-stored value of whichever date field is
    // NOT in this patch. Check that case here, where the stored row is
    // actually available, so a single-field date PATCH can't produce an
    // inverted range that a two-field PATCH would have rejected.
    if (rest.startDate !== undefined || rest.endDate !== undefined) {
      const [current] = await tx.select().from(cycles).where(eq(cycles.id, id));
      if (!current) throw new NotFoundError('cycle');
      const nextStart = rest.startDate ?? current.startDate;
      const nextEnd = rest.endDate ?? current.endDate;
      if (nextEnd < nextStart) {
        throw new ConflictError('endDate must not be before startDate');
      }
    }

    // See modules.service.ts's updateModule — a memberIds-only patch leaves
    // `rest` empty, and `.set({})` is invalid SQL.
    const row = Object.keys(rest).length
      ? (await tx.update(cycles).set(rest).where(eq(cycles.id, id)).returning())[0]
      : (await tx.select().from(cycles).where(eq(cycles.id, id)))[0];
    if (!row) throw new NotFoundError('cycle');
    if (memberIds) {
      await tx.delete(cycleMembers).where(eq(cycleMembers.cycleId, id));
      if (memberIds.length) {
        await tx.insert(cycleMembers).values(memberIds.map((memberId) => ({ cycleId: id, memberId })));
      }
    }
    const finalMemberIds = memberIds ?? (await tx.select().from(cycleMembers).where(eq(cycleMembers.cycleId, id))).map((m) => m.memberId);
    return { ...row, memberIds: finalMemberIds };
  });
}

export async function deleteCycle(id: string) {
  await db.delete(cycles).where(eq(cycles.id, id));
}
