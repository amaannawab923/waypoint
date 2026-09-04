import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentAssignments, agents, members } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';
import { toggleTicketAssignee } from './tickets.service.js';
import { addComment } from './comments.service.js';

export async function listAgentAssignments() {
  return db.select().from(agentAssignments);
}

async function ensureAgentAssignment(ticketId: string, agentId: string) {
  await db
    .insert(agentAssignments)
    .values({ id: newId('aa'), ticketId, agentId, status: 'queued' })
    .onConflictDoNothing({ target: [agentAssignments.ticketId, agentAssignments.agentId] });
}

export async function ensureAgentAssignments(ticketId: string, agentIds: string[]) {
  for (const agentId of agentIds) await ensureAgentAssignment(ticketId, agentId);
}

// Same composition as the mock: toggle the assignee (shared mechanics with a
// human assignee), then also maintain the agent's own run record.
export async function toggleTicketAgent(ticketId: string, agentId: string) {
  const item = await toggleTicketAssignee(ticketId, agentId);
  if (item.assigneeIds.includes(agentId)) {
    await ensureAgentAssignment(ticketId, agentId);
  }
  return item;
}

// Toggle off, close out the run record, and post a hand-off comment from the
// current user — reuses addComment's own activity-logging rather than
// duplicating it, same as the mock's call into addComment.
export async function takeBackOverFromAgent(ticketId: string, agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const [me] = await db.select().from(members).where(eq(members.id, CURRENT_USER_ID));
  const item = await toggleTicketAssignee(ticketId, agentId);
  await db
    .update(agentAssignments)
    .set({ status: 'done', updatedAt: new Date() })
    .where(and(eq(agentAssignments.ticketId, ticketId), eq(agentAssignments.agentId, agentId)));
  // Plain text, no wrapping tags: this comment goes through addComment
  // (the human/system comment path), which the frontend renders as a plain
  // React text node, not HTML (see TicketDetailPage.tsx's comment list and
  // validation/tickets.schema.ts's addCommentSchema comment for why that
  // path is deliberately unescaped). Wrapping this in <p>...</p> made the
  // literal tag text show up in the UI instead of a paragraph.
  await addComment(
    ticketId,
    `${me?.displayName ?? 'Someone'} took this back over from ${agent ? `${agent.name} (agent)` : 'the agent'}.`,
  );
  return item;
}
