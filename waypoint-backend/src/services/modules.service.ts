import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workModules, moduleMembers } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';

async function attachMemberIds<T extends { id: string }>(rows: T[]): Promise<(T & { memberIds: string[] })[]> {
  if (rows.length === 0) return [];
  const links = await db
    .select()
    .from(moduleMembers)
    .where(inArray(moduleMembers.moduleId, rows.map((r) => r.id)));
  const byModule = new Map<string, string[]>();
  for (const l of links) byModule.set(l.moduleId, [...(byModule.get(l.moduleId) ?? []), l.memberId]);
  return rows.map((r) => ({ ...r, memberIds: byModule.get(r.id) ?? [] }));
}

export async function listModules(projectId: string) {
  const rows = await db.select().from(workModules).where(eq(workModules.projectId, projectId));
  return attachMemberIds(rows);
}

export async function listAllModules() {
  const rows = await db.select().from(workModules);
  return attachMemberIds(rows);
}

export interface CreateModuleInput {
  name: string;
  description?: string;
  leadId?: string | null;
  status?: (typeof workModules.$inferInsert)['status'];
  startDate?: string | null;
  targetDate?: string | null;
  memberIds?: string[];
}

export async function createModule(projectId: string, input: CreateModuleInput) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(workModules)
      .values({
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
      await tx.insert(moduleMembers).values(input.memberIds.map((memberId) => ({ moduleId: row.id, memberId })));
    }
    return { ...row, memberIds: input.memberIds ?? [] };
  });
}

export async function updateModule(id: string, patch: Partial<CreateModuleInput>) {
  return db.transaction(async (tx) => {
    const { memberIds, ...rest } = patch;
    // A memberIds-only patch (exactly what the Members multi-select sends
    // on every add/remove) leaves `rest` empty — `.set({})` builds
    // `UPDATE ... SET WHERE id = ...`, invalid SQL that Postgres rejects
    // with a syntax error. Skip the scalar update entirely when there's
    // nothing scalar to change.
    const row = Object.keys(rest).length
      ? (await tx.update(workModules).set(rest).where(eq(workModules.id, id)).returning())[0]
      : (await tx.select().from(workModules).where(eq(workModules.id, id)))[0];
    if (!row) throw new NotFoundError('module');
    if (memberIds) {
      await tx.delete(moduleMembers).where(eq(moduleMembers.moduleId, id));
      if (memberIds.length) {
        await tx.insert(moduleMembers).values(memberIds.map((memberId) => ({ moduleId: id, memberId })));
      }
    }
    const finalMemberIds = memberIds ?? (await tx.select().from(moduleMembers).where(eq(moduleMembers.moduleId, id))).map((m) => m.memberId);
    return { ...row, memberIds: finalMemberIds };
  });
}
