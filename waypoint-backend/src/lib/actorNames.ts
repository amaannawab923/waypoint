import { inArray, and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { members, agents } from '../db/schema/index.js';
import { currentWorkspaceId } from './requestContext.js';

// Resolves member/agent ids — the polymorphic "actor" ids used for ticket
// assignees, comment authors, and activity actors (see tickets.ts's own
// schema comments on why there's no single FK target) — to display names in
// one batched pair of queries, not one query per id. A ticket with several
// comments/assignees would otherwise be N+1. Mirrors tickets.service.ts's
// own nameForActor(), which does the same member-then-agent lookup one id at
// a time for activity-log write-time text; this is the batched read-path
// sibling of that, not a replacement for it.
//
// Ninth review round, proven live: every existing caller only ever hands
// this ids read back off an already-scoped row, which is why an unscoped
// lookup here survived eight rounds — but mcp/proposalTools.ts's two propose
// handlers hand it a caller-supplied assigneeId/assigneeIds directly, and an
// unscoped lookup turned that into a cross-tenant PII read (a stranger's
// real display name) plus an existence oracle. Scoped to the caller's own
// workspace like every other lookup in this audit.
export async function resolveActorNames(ids: string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map();
  const workspaceId = currentWorkspaceId();
  const [memberRows, agentRows] = await Promise.all([
    db
      .select({ id: members.id, name: members.displayName })
      .from(members)
      .where(and(inArray(members.id, uniqueIds), eq(members.workspaceId, workspaceId))),
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(inArray(agents.id, uniqueIds), eq(agents.workspaceId, workspaceId))),
  ]);
  const map = new Map<string, string>();
  memberRows.forEach((m) => map.set(m.id, m.name));
  agentRows.forEach((a) => map.set(a.id, `${a.name} (agent)`));
  return map;
}
