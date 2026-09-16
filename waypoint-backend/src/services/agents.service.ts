import { eq, and, inArray, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, agentProjectScopes, projects } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';

type AgentRow = typeof agents.$inferSelect;

// Eighth review round, proven live: scopeProjectIds was written into
// agent_project_scopes with no check at all — a real row binding a
// foreign workspace's project into your agent's scope.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function assertProjectsInWorkspace(tx: Tx, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(inArray(projects.id, projectIds), eq(projects.workspaceId, currentWorkspaceId())));
  const known = new Set(rows.map((r) => r.id));
  const unknown = projectIds.filter((id) => !known.has(id));
  if (unknown.length) throw new ValidationError(`unknown projectId(s): ${unknown.join(', ')}`);
}

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

// AT11 (ROAD-146) review fix: agents has a direct workspaceId column
// (set in createAgent below already) — every read/write here previously
// ignored it.
export async function listAgents() {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, currentWorkspaceId()))
    .orderBy(desc(agents.updatedAt));
  return attachScopes(rows);
}

export async function getAgent(id: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.workspaceId, currentWorkspaceId())));
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
        workspaceId: currentWorkspaceId(),
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
        createdById: currentMemberId(),
      })
      .returning();
    const scopeProjectIds = input.scopeProjectIds ?? [];
    if (scopeProjectIds.length) {
      await assertProjectsInWorkspace(tx, scopeProjectIds);
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
      .where(and(eq(agents.id, id), eq(agents.workspaceId, currentWorkspaceId())))
      .returning();
    if (!row) throw new NotFoundError('agent');
    if (scopeProjectIds) {
      await assertProjectsInWorkspace(tx, scopeProjectIds);
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
  await db.delete(agents).where(and(eq(agents.id, id), eq(agents.workspaceId, currentWorkspaceId())));
}
