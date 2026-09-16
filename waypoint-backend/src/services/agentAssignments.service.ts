import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentAssignments, agents, members, tickets } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { NotFoundError } from '../middleware/errors.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';
import { assertTicketInWorkspace, workspaceProjectIdsSubquery } from '../lib/workspaceGuard.js';
import { toggleTicketAssignee } from './tickets.service.js';
import { addComment } from './comments.service.js';

// AT11 (ROAD-146) review fix: no scoping at all previously — agent
// assignments have no direct workspaceId, so this scopes through the
// ticket's own project, the same subquery pattern used throughout this
// epic. toggleTicketAgent and takeBackOverFromAgent reach the database
// only after toggleTicketAssignee's own now-guarded ticketId check has
// already run first (see tickets.service.ts), so they don't need a
// second guard of their own. ensureAgentAssignments does NOT go through
// toggleTicketAssignee — a second look while writing this round's test
// coverage found it was still a real, unguarded cross-tenant write (any
// workspace's ticketId could have an agent assignment inserted against
// it, via POST /tickets/:id/agent-assignments) even after the first
// review-fix pass; it gets its own explicit guard below.
export async function listAgentAssignments() {
  return db
    .select()
    .from(agentAssignments)
    .where(
      inArray(
        agentAssignments.ticketId,
        db.select({ id: tickets.id }).from(tickets).where(inArray(tickets.projectId, workspaceProjectIdsSubquery())),
      ),
    );
}

async function ensureAgentAssignment(ticketId: string, agentId: string) {
  await db
    .insert(agentAssignments)
    .values({ id: newId('aa'), ticketId, agentId, status: 'queued' })
    .onConflictDoNothing({ target: [agentAssignments.ticketId, agentAssignments.agentId] });
}

export async function ensureAgentAssignments(ticketId: string, agentIds: string[]) {
  await assertTicketInWorkspace(ticketId);
  if (agentIds.length === 0) return;
  // Second review round: the ticket guard above says nothing about the
  // agent ids themselves — without this, another workspace's real agent
  // id could be attached to your ticket (and a fake id would 500 on the
  // FK instead of failing cleanly, a second, separate existence oracle).
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, agentIds), eq(agents.workspaceId, currentWorkspaceId())));
  const ownedIds = new Set(owned.map((a) => a.id));
  const unknown = agentIds.filter((id) => !ownedIds.has(id));
  if (unknown.length) throw new NotFoundError('agent');
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
//
// Second review round: the two reads below used to run BEFORE
// toggleTicketAssignee's guard, contradicting this file's own header
// comment about ordering. Not itself exploitable — a throw from the
// guard aborts the function before either read result is ever used —
// but reordered to actually match the stated invariant, and so a
// doomed cross-tenant call doesn't run two queries it'll never use.
export async function takeBackOverFromAgent(ticketId: string, agentId: string) {
  const item = await toggleTicketAssignee(ticketId, agentId);
  // Tenth review round: this read is only safe today because no
  // ticket_assignees insert path lets a foreign agentId reach an
  // in-workspace ticket (the invariant toggleTicketAssignee/
  // ensureAgentAssignments both enforce) — the same "helper trusts its
  // caller's own guard" shape that made resolveActorNames exploitable in
  // round 9. Scoped directly so this read never depends on that holding.
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, currentWorkspaceId())));
  const [me] = await db.select().from(members).where(eq(members.id, currentMemberId()));
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
