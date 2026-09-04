import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workstreams, workstreamMembers } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';

async function attachMemberIds<T extends { id: string }>(rows: T[]): Promise<(T & { memberIds: string[] })[]> {
  if (rows.length === 0) return [];
  const links = await db
    .select()
    .from(workstreamMembers)
    .where(inArray(workstreamMembers.workstreamId, rows.map((r) => r.id)));
  const byWorkstream = new Map<string, string[]>();
  for (const l of links) byWorkstream.set(l.workstreamId, [...(byWorkstream.get(l.workstreamId) ?? []), l.memberId]);
  return rows.map((r) => ({ ...r, memberIds: byWorkstream.get(r.id) ?? [] }));
}

export async function listWorkstreams(projectId: string) {
  const rows = await db.select().from(workstreams).where(eq(workstreams.projectId, projectId));
  return attachMemberIds(rows);
}

export async function listAllWorkstreams() {
  const rows = await db.select().from(workstreams);
  return attachMemberIds(rows);
}

export interface CreateWorkstreamInput {
  name: string;
  description?: string;
  leadId?: string | null;
  status?: (typeof workstreams.$inferInsert)['status'];
  startDate?: string | null;
  targetDate?: string | null;
  memberIds?: string[];
}

export async function createWorkstream(projectId: string, input: CreateWorkstreamInput) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(workstreams)
      .values({
        // Opaque row-id prefix, deliberately unchanged — same call C2 made
        // when it left newId('wi') in place for tickets.
        id: newId('mod'),
        projectId,
        name: input.name,
        description: input.description ?? '',
        leadId: input.leadId ?? null,
        status: input.status ?? 'planned',
        startDate: input.startDate ?? null,
        targetDate: input.targetDate ?? null,
      })
      .returning();
    if (input.memberIds?.length) {
      await tx
        .insert(workstreamMembers)
        .values(input.memberIds.map((memberId) => ({ workstreamId: row.id, memberId })));
    }
    return { ...row, memberIds: input.memberIds ?? [] };
  });
}

export async function updateWorkstream(id: string, patch: Partial<CreateWorkstreamInput>) {
  return db.transaction(async (tx) => {
    const { memberIds, ...rest } = patch;
    // A memberIds-only patch (exactly what the Members multi-select sends
    // on every add/remove) leaves `rest` empty — `.set({})` builds
    // `UPDATE ... SET WHERE id = ...`, invalid SQL that Postgres rejects
    // with a syntax error. Skip the scalar update entirely when there's
    // nothing scalar to change.
    const row = Object.keys(rest).length
      ? (await tx.update(workstreams).set(rest).where(eq(workstreams.id, id)).returning())[0]
      : (await tx.select().from(workstreams).where(eq(workstreams.id, id)))[0];
    if (!row) throw new NotFoundError('workstream');
    if (memberIds) {
      await tx.delete(workstreamMembers).where(eq(workstreamMembers.workstreamId, id));
      if (memberIds.length) {
        await tx.insert(workstreamMembers).values(memberIds.map((memberId) => ({ workstreamId: id, memberId })));
      }
    }
    const finalMemberIds =
      memberIds ??
      (await tx.select().from(workstreamMembers).where(eq(workstreamMembers.workstreamId, id))).map((m) => m.memberId);
    return { ...row, memberIds: finalMemberIds };
  });
}
