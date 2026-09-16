import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workstreams, workstreamMembers, members } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { currentWorkspaceId } from '../lib/requestContext.js';
import { assertProjectInWorkspace, workspaceProjectIdsSubquery } from '../lib/workspaceGuard.js';

// Eighth review round, proven live: leadId/memberIds were written with no
// check at all — a real cross-tenant workstreamMembers row, or a lead
// pointed at a stranger's memberId. Same helper as sprints.service.ts's
// own copy of this fix.
async function assertMembersInWorkspace(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.select({ id: members.id }).from(members).where(and(inArray(members.id, ids), eq(members.workspaceId, currentWorkspaceId())));
  const known = new Set(rows.map((r) => r.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new ValidationError(`unknown member id(s): ${unknown.join(', ')}`);
}

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
  await assertProjectInWorkspace(projectId);
  const rows = await db.select().from(workstreams).where(eq(workstreams.projectId, projectId));
  return attachMemberIds(rows);
}

// AT11 (ROAD-146): scoped via its projects — workstreams has no
// workspaceId column of its own.
export async function listAllWorkstreams() {
  const rows = await db.select().from(workstreams).where(inArray(workstreams.projectId, workspaceProjectIdsSubquery()));
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
  await assertProjectInWorkspace(projectId);
  await assertMembersInWorkspace([...(input.leadId ? [input.leadId] : []), ...(input.memberIds ?? [])]);
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
  await assertMembersInWorkspace([...(patch.leadId ? [patch.leadId] : []), ...(patch.memberIds ?? [])]);
  return db.transaction(async (tx) => {
    const { memberIds, ...rest } = patch;
    // A memberIds-only patch (exactly what the Members multi-select sends
    // on every add/remove) leaves `rest` empty — `.set({})` builds
    // `UPDATE ... SET WHERE id = ...`, invalid SQL that Postgres rejects
    // with a syntax error. Skip the scalar update entirely when there's
    // nothing scalar to change.
    // AT11 (ROAD-146): both branches scoped identically — a cross-tenant
    // id matches zero rows either way, and the existing NotFoundError
    // below already covers "no row" regardless of which branch ran.
    const scope = and(eq(workstreams.id, id), inArray(workstreams.projectId, workspaceProjectIdsSubquery()));
    const row = Object.keys(rest).length
      ? (await tx.update(workstreams).set(rest).where(scope).returning())[0]
      : (await tx.select().from(workstreams).where(scope))[0];
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
