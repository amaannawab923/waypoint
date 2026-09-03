import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { members, agents } from '../db/schema/index.js';

// Resolves member/agent ids — the polymorphic "actor" ids used for ticket
// assignees, comment authors, and activity actors (see tickets.ts's own
// schema comments on why there's no single FK target) — to display names in
// one batched pair of queries, not one query per id. A ticket with several
// comments/assignees would otherwise be N+1. Mirrors tickets.service.ts's
// own nameForActor(), which does the same member-then-agent lookup one id at
// a time for activity-log write-time text; this is the batched read-path
// sibling of that, not a replacement for it.
export async function resolveActorNames(ids: string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map();
  const [memberRows, agentRows] = await Promise.all([
    db.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, uniqueIds)),
    db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, uniqueIds)),
  ]);
  const map = new Map<string, string>();
  memberRows.forEach((m) => map.set(m.id, m.name));
  agentRows.forEach((a) => map.set(a.id, `${a.name} (agent)`));
  return map;
}
