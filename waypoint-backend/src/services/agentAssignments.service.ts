import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentAssignments, agents, members } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';
import { toggleWorkItemAssignee } from './workItems.service.js';
import { addComment } from './comments.service.js';

export async function listAgentAssignments() {
  return db.select().from(agentAssignments);
}

async function ensureAgentAssignment(workItemId: string, agentId: string) {
  await db
    .insert(agentAssignments)
    .values({ id: newId('aa'), workItemId, agentId, status: 'queued' })
    .onConflictDoNothing({ target: [agentAssignments.workItemId, agentAssignments.agentId] });
}

export async function ensureAgentAssignments(workItemId: string, agentIds: string[]) {
  for (const agentId of agentIds) await ensureAgentAssignment(workItemId, agentId);
}

// Same composition as the mock: toggle the assignee (shared mechanics with a
// human assignee), then also maintain the agent's own run record.
export async function toggleWorkItemAgent(workItemId: string, agentId: string) {
  const item = await toggleWorkItemAssignee(workItemId, agentId);
  if (item.assigneeIds.includes(agentId)) {
    await ensureAgentAssignment(workItemId, agentId);
  }
  return item;
}

// Toggle off, close out the run record, and post a hand-off comment from the
// current user — reuses addComment's own activity-logging rather than
// duplicating it, same as the mock's call into addComment.
export async function takeBackOverFromAgent(workItemId: string, agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const [me] = await db.select().from(members).where(eq(members.id, CURRENT_USER_ID));
  const item = await toggleWorkItemAssignee(workItemId, agentId);
  await db
    .update(agentAssignments)
    .set({ status: 'done', updatedAt: new Date() })
    .where(and(eq(agentAssignments.workItemId, workItemId), eq(agentAssignments.agentId, agentId)));
  await addComment(
    workItemId,
    `<p>${me?.displayName ?? 'Someone'} took this back over from ${agent ? `${agent.name} (agent)` : 'the agent'}.</p>`,
  );
  return item;
}
