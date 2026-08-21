import { eq, inArray, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, agentProjectScopes } from '../db/schema/index.js';
import { NotFoundError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID, WORKSPACE_ID } from '../lib/currentUser.js';

type AgentRow = typeof agents.$inferSelect;

function toEntity(row: AgentRow, scopeProjectIds: string[]) {
  const { instructionsFilename, instructionsContentMarkdown, ...rest } = row;
  return {
    ...rest,
    instructionsFile: { filename: instructionsFilename, contentMarkdown: instructionsContentMarkdown },
    scopeProjectIds,
  };
}

async function attachScopes(rows: AgentRow[]) {
  if (rows.length === 0) return [];
  const links = await db
    .select()
    .from(agentProjectScopes)
    .where(inArray(agentProjectScopes.agentId, rows.map((r) => r.id)));
  const byAgent = new Map<string, string[]>();
  for (const l of links) byAgent.set(l.agentId, [...(byAgent.get(l.agentId) ?? []), l.projectId]);
  return rows.map((r) => toEntity(r, byAgent.get(r.id) ?? []));
}

export async function listAgents() {
  const rows = await db.select().from(agents).orderBy(desc(agents.updatedAt));
  return attachScopes(rows);
}

export async function getAgent(id: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  if (!row) return undefined;
  const [entity] = await attachScopes([row]);
  return entity;
}

export interface CreateAgentInput {
  name: string;
  avatarColor: string;
  instructionsFile: { filename: string; contentMarkdown: string };
  scopeAllProjects: boolean;
  scopeProjectIds?: string[];
  executionMethod: (typeof agents.$inferInsert)['executionMethod'];
  model: string;
  autonomy: (typeof agents.$inferInsert)['autonomy'];
  triggers?: string[];
  templateId?: string;
}

export async function createAgent(input: CreateAgentInput) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        id: newId('agent'),
        workspaceId: WORKSPACE_ID,
        name: input.name,
        avatarColor: input.avatarColor,
        instructionsFilename: input.instructionsFile.filename,
        instructionsContentMarkdown: input.instructionsFile.contentMarkdown,
        scopeAllProjects: input.scopeAllProjects,
        executionMethod: input.executionMethod,
        model: input.model,
        autonomy: input.autonomy,
        triggers: input.triggers ?? ['on-assign'],
        templateId: input.templateId,
        isActive: true,
        createdById: CURRENT_USER_ID,
      })
      .returning();
    const scopeProjectIds = input.scopeProjectIds ?? [];
    if (scopeProjectIds.length) {
      await tx.insert(agentProjectScopes).values(scopeProjectIds.map((projectId) => ({ agentId: row.id, projectId })));
    }
    return toEntity(row, scopeProjectIds);
  });
}

export interface UpdateAgentPatch {
  name?: string;
  avatarColor?: string;
  instructionsFile?: { filename: string; contentMarkdown: string };
  scopeAllProjects?: boolean;
  scopeProjectIds?: string[];
  executionMethod?: (typeof agents.$inferInsert)['executionMethod'];
  model?: string;
  autonomy?: (typeof agents.$inferInsert)['autonomy'];
  triggers?: string[];
  isActive?: boolean;
}

export async function updateAgent(id: string, patch: UpdateAgentPatch) {
  return db.transaction(async (tx) => {
    const { instructionsFile, scopeProjectIds, ...rest } = patch;
    const columnPatch: Partial<typeof agents.$inferInsert> = { ...rest };
    if (instructionsFile) {
      columnPatch.instructionsFilename = instructionsFile.filename;
      columnPatch.instructionsContentMarkdown = instructionsFile.contentMarkdown;
    }
    const [row] = await tx
      .update(agents)
      .set({ ...columnPatch, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning();
    if (!row) throw new NotFoundError('agent');
    if (scopeProjectIds) {
      await tx.delete(agentProjectScopes).where(eq(agentProjectScopes.agentId, id));
      if (scopeProjectIds.length) {
        await tx.insert(agentProjectScopes).values(scopeProjectIds.map((projectId) => ({ agentId: id, projectId })));
      }
    }
    const finalScopeIds =
      scopeProjectIds ?? (await tx.select().from(agentProjectScopes).where(eq(agentProjectScopes.agentId, id))).map((s) => s.projectId);
    return toEntity(row, finalScopeIds);
  });
}

export async function deleteAgent(id: string) {
  await db.delete(agents).where(eq(agents.id, id));
}
