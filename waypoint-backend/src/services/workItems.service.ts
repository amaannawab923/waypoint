import { eq, and, ne, isNull, inArray, asc, desc, sql, ilike, lte, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  workItems,
  workItemLabels,
  workItemAssignees,
  workItemLinks,
  labels,
  projects,
  members,
  agents,
} from '../db/schema/index.js';
import { NotFoundError, ConflictError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';
import { logActivity } from './activity.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// assigneeId is polymorphic (member OR agent, see work-items.ts schema
// comment) — no DB-level FK is possible, so existence is checked here
// instead. Without this, toggling a garbage id silently persists it.
async function validateAssigneeIds(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const [memberRows, agentRows] = await Promise.all([
    tx.select({ id: members.id }).from(members).where(inArray(members.id, ids)),
    tx.select({ id: agents.id }).from(agents).where(inArray(agents.id, ids)),
  ]);
  const known = new Set([...memberRows.map((m) => m.id), ...agentRows.map((a) => a.id)]);
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new ConflictError(`unknown assignee id(s): ${unknown.join(', ')}`);
  }
}
type WorkItemRow = typeof workItems.$inferSelect;
export type Enriched = WorkItemRow & { assigneeIds: string[]; labelIds: string[]; links: (typeof workItemLinks.$inferSelect)[] };

async function attachRelations(rows: WorkItemRow[], executor: Tx | typeof db = db): Promise<Enriched[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [labelRows, assigneeRows, linkRows] = await Promise.all([
    executor.select().from(workItemLabels).where(inArray(workItemLabels.workItemId, ids)),
    executor.select().from(workItemAssignees).where(inArray(workItemAssignees.workItemId, ids)),
    executor.select().from(workItemLinks).where(inArray(workItemLinks.workItemId, ids)),
  ]);
  const labelsByItem = new Map<string, string[]>();
  for (const l of labelRows) labelsByItem.set(l.workItemId, [...(labelsByItem.get(l.workItemId) ?? []), l.labelId]);
  const assigneesByItem = new Map<string, string[]>();
  for (const a of assigneeRows)
    assigneesByItem.set(a.workItemId, [...(assigneesByItem.get(a.workItemId) ?? []), a.assigneeId]);
  const linksByItem = new Map<string, (typeof workItemLinks.$inferSelect)[]>();
  for (const l of linkRows) linksByItem.set(l.workItemId, [...(linksByItem.get(l.workItemId) ?? []), l]);
  return rows.map((r) => ({
    ...r,
    assigneeIds: assigneesByItem.get(r.id) ?? [],
    labelIds: labelsByItem.get(r.id) ?? [],
    links: linksByItem.get(r.id) ?? [],
  }));
}

export interface WorkItemFilters {
  assigneeId?: string;
  stateId?: string;
  priority?: (typeof workItems.$inferInsert)['priority'];
  // ISO date (YYYY-MM-DD) — matches items due on or before this date, e.g.
  // "what's overdue" is dueBefore=<today>.
  dueBefore?: string;
  // Caps how many rows the query itself fetches (not a post-fetch slice —
  // see the callers below, which request limit + 1 so they can tell a
  // truncated result apart from one that happened to end exactly at the
  // limit). Undefined means unlimited, preserving this function's original
  // behavior for callers (e.g. the REST routes) that never pass one.
  limit?: number;
}

// A literal `%` or `_` in a LIKE pattern is a wildcard, not a literal
// character — Postgres's LIKE (and Drizzle's ilike()) defaults to `\` as
// the escape character, so escaping the three metacharacters with a
// backslash here (query text, not the query's own outer `%...%` wrapper) is
// enough; no explicit ESCAPE clause is needed. Without this, a search for
// e.g. the literal string "%" or "_" matches every row instead of the
// literal character.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

// Fallback cap for the assignee pre-query below when a caller doesn't pass
// its own `filters.limit` (every current MCP tool caller does, via
// effectiveLimit + 1 — see workItemTools.ts — so this mostly guards any
// future caller that doesn't). Not meant to be precise, just to bound
// worst-case work; the main query's own .limit() is still what
// authoritatively caps the final result.
const MAX_ASSIGNEE_PREQUERY_ROWS = 500;

// assigneeId can't just be pushed into the WHERE alongside the others —
// assignment is a separate many-to-many table (workItemAssignees), not a
// column on workItems — so it's resolved as its own pre-query. Returns null
// (not []) as a "no possible matches" sentinel so callers can short-circuit
// before ever querying workItems, rather than issuing a query they already
// know returns nothing. When projectId is given (listWorkItems only —
// listAllWorkItems has no project to scope by), the pre-query itself is
// scoped to that project via a join, which already keeps it fairly bounded
// in practice — but neither branch had an actual LIMIT before, so an
// assignee with many items (most sharply felt in listAllWorkItems, which
// has no project to scope by at all) still made this pre-query fetch
// everything before the main query's own .limit() ever got a chance to
// matter. Both branches now cap at filters.limit (falling back to
// MAX_ASSIGNEE_PREQUERY_ROWS) for that reason.
async function withFilters(
  baseConditions: SQL[],
  filters: WorkItemFilters,
  projectId?: string,
  executor: Tx | typeof db = db,
): Promise<SQL[] | null> {
  const conditions = [...baseConditions];
  if (filters.stateId) conditions.push(eq(workItems.stateId, filters.stateId));
  if (filters.priority) conditions.push(eq(workItems.priority, filters.priority));
  if (filters.dueBefore) conditions.push(lte(workItems.dueDate, filters.dueBefore));
  if (filters.assigneeId) {
    const base = executor.select({ workItemId: workItemAssignees.workItemId }).from(workItemAssignees);
    // Bounds worst-case pre-query work, most importantly for listAllWorkItems
    // (no projectId to scope by): without a limit here, an assignee with
    // many items makes this pre-query fetch every one of them before the
    // main query's own .limit() (applied below, in the caller) ever gets a
    // chance to matter. Doesn't need to be exact — the main query still
    // authoritatively limits the final result — this just stops the
    // pre-query itself from being unbounded.
    const assigneeRows = await (projectId
      ? base
          .innerJoin(workItems, eq(workItems.id, workItemAssignees.workItemId))
          .where(and(eq(workItemAssignees.assigneeId, filters.assigneeId), eq(workItems.projectId, projectId)))
          .limit(filters.limit ?? MAX_ASSIGNEE_PREQUERY_ROWS)
      : base
          .where(eq(workItemAssignees.assigneeId, filters.assigneeId))
          .limit(filters.limit ?? MAX_ASSIGNEE_PREQUERY_ROWS));
    if (assigneeRows.length === 0) return null;
    conditions.push(inArray(workItems.id, assigneeRows.map((r) => r.workItemId)));
  }
  return conditions;
}

export async function listWorkItems(projectId: string, filters: WorkItemFilters = {}) {
  const conditions = await withFilters([eq(workItems.projectId, projectId), eq(workItems.isDraft, false)], filters, projectId);
  if (!conditions) return [];
  const query = db
    .select()
    .from(workItems)
    .where(and(...conditions))
    .orderBy(asc(workItems.sortOrder));
  const rows = filters.limit ? await query.limit(filters.limit) : await query;
  return attachRelations(rows);
}

export async function listAllWorkItems(filters: WorkItemFilters = {}) {
  const conditions = await withFilters([eq(workItems.isDraft, false)], filters);
  if (!conditions) return [];
  const query = db
    .select()
    .from(workItems)
    .where(and(...conditions))
    .orderBy(asc(workItems.sortOrder));
  const rows = filters.limit ? await query.limit(filters.limit) : await query;
  return attachRelations(rows);
}

// Title-only match for now — description/identifier matching is a
// reasonable fast-follow, not silently promised here.
export async function searchWorkItems(query: string, projectId?: string, limit?: number) {
  const conditions = [eq(workItems.isDraft, false), ilike(workItems.title, `%${escapeLikePattern(query)}%`)];
  if (projectId) conditions.push(eq(workItems.projectId, projectId));
  const dbQuery = db
    .select()
    .from(workItems)
    .where(and(...conditions))
    .orderBy(asc(workItems.sortOrder));
  const rows = limit ? await dbQuery.limit(limit) : await dbQuery;
  return attachRelations(rows);
}

export async function listDraftWorkItems() {
  const rows = await db
    .select()
    .from(workItems)
    .where(and(eq(workItems.isDraft, true), eq(workItems.createdById, CURRENT_USER_ID)));
  return attachRelations(rows);
}

export async function getWorkItem(id: string) {
  const [row] = await db.select().from(workItems).where(eq(workItems.id, id));
  if (!row) return undefined;
  const [enriched] = await attachRelations([row]);
  return enriched;
}

export async function getWorkItemByIdentifier(identifier: string) {
  const [row] = await db.select().from(workItems).where(eq(workItems.identifier, identifier));
  if (!row) return undefined;
  const [enriched] = await attachRelations([row]);
  return enriched;
}

export async function listSubItems(parentId: string) {
  const rows = await db.select().from(workItems).where(eq(workItems.parentId, parentId));
  return attachRelations(rows);
}

export interface CreateWorkItemInput {
  projectId: string;
  title: string;
  description?: string;
  stateId: string;
  priority?: (typeof workItems.$inferInsert)['priority'];
  assigneeIds?: string[];
  labelIds?: string[];
  moduleId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  isDraft?: boolean;
}

export async function createWorkItem(input: CreateWorkItemInput) {
  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId));
    // Lock the project's existing rows to serialize sequenceId allocation
    // under concurrent requests — the mock's Math.max(...)+1 was only safe
    // single-threaded; a unique(project_id, sequence_id) constraint backs
    // this up if two requests still race.
    const existing = await tx
      .select({ sequenceId: workItems.sequenceId, sortOrder: workItems.sortOrder })
      .from(workItems)
      .where(eq(workItems.projectId, input.projectId))
      .orderBy(desc(workItems.sequenceId))
      .limit(1)
      .for('update');
    const nextSeq = (existing[0]?.sequenceId ?? 0) + 1;
    const maxSortOrder = existing[0]?.sortOrder ? Number(existing[0].sortOrder) : 0;

    const [row] = await tx
      .insert(workItems)
      .values({
        id: newId('wi'),
        projectId: input.projectId,
        identifier: `${project?.identifier ?? 'WI'}-${nextSeq}`,
        sequenceId: nextSeq,
        title: input.title,
        description: input.description ?? '',
        stateId: input.stateId,
        priority: input.priority ?? 'none',
        moduleId: input.moduleId ?? null,
        cycleId: input.cycleId ?? null,
        parentId: input.parentId ?? null,
        createdById: CURRENT_USER_ID,
        isDraft: input.isDraft ?? false,
        sortOrder: String(maxSortOrder + 1000),
      })
      .returning();

    if (input.assigneeIds?.length) {
      await validateAssigneeIds(tx, input.assigneeIds);
      await tx.insert(workItemAssignees).values(
        input.assigneeIds.map((assigneeId) => ({
          workItemId: row.id,
          assigneeId,
          assigneeKind: (assigneeId.startsWith('agent-') ? 'agent' : 'member') as 'agent' | 'member',
        })),
      );
    }
    if (input.labelIds?.length) {
      await tx.insert(workItemLabels).values(input.labelIds.map((labelId) => ({ workItemId: row.id, labelId })));
    }

    await logActivity(tx, {
      workItemId: row.id,
      actorId: CURRENT_USER_ID,
      verb: 'created',
      detail: 'created the work item',
      createdAt: row.createdAt,
    });

    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

async function nameForActor(tx: Tx, id: string): Promise<string | undefined> {
  const [member] = await tx.select().from(members).where(eq(members.id, id));
  if (member) return member.displayName;
  const [agent] = await tx.select().from(agents).where(eq(agents.id, id));
  return agent ? `${agent.name} (agent)` : undefined;
}

async function logAssigneeChanges(tx: Tx, workItemId: string, beforeIds: string[], afterIds: string[]) {
  const before = new Set(beforeIds);
  const after = new Set(afterIds);
  for (const id of afterIds.filter((a) => !before.has(a))) {
    await logActivity(tx, {
      workItemId,
      actorId: CURRENT_USER_ID,
      verb: 'assignee_added',
      detail: `added ${(await nameForActor(tx, id)) ?? 'an assignee'} as assignee`,
    });
  }
  for (const id of beforeIds.filter((b) => !after.has(b))) {
    await logActivity(tx, {
      workItemId,
      actorId: CURRENT_USER_ID,
      verb: 'assignee_removed',
      detail: `removed ${(await nameForActor(tx, id)) ?? 'an assignee'} as assignee`,
    });
  }
}

async function logLabelChanges(tx: Tx, workItemId: string, beforeIds: string[], afterIds: string[]) {
  const before = new Set(beforeIds);
  const after = new Set(afterIds);
  for (const id of afterIds.filter((l) => !before.has(l))) {
    const [label] = await tx.select().from(labels).where(eq(labels.id, id));
    await logActivity(tx, {
      workItemId,
      actorId: CURRENT_USER_ID,
      verb: 'label_added',
      detail: `added ${label?.name ?? 'a label'} as a label`,
    });
  }
  for (const id of beforeIds.filter((b) => !after.has(b))) {
    const [label] = await tx.select().from(labels).where(eq(labels.id, id));
    await logActivity(tx, {
      workItemId,
      actorId: CURRENT_USER_ID,
      verb: 'label_removed',
      detail: `removed ${label?.name ?? 'a label'} as a label`,
    });
  }
}

export interface UpdateWorkItemPatch {
  title?: string;
  description?: string;
  stateId?: string;
  priority?: (typeof workItems.$inferInsert)['priority'];
  assigneeIds?: string[];
  labelIds?: string[];
  moduleId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  estimatePoints?: number | null;
  estimateValue?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  isDraft?: boolean;
}

export async function updateWorkItem(id: string, patch: UpdateWorkItemPatch) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(workItems).where(eq(workItems.id, id));
    if (!current) throw new NotFoundError('work item');
    const [currentEnriched] = await attachRelations([current], tx);

    const stateChanged = Boolean(patch.stateId && patch.stateId !== current.stateId);
    if (stateChanged) {
      await logActivity(tx, { workItemId: id, actorId: CURRENT_USER_ID, verb: 'state_changed', detail: 'changed state' });
    }
    if (patch.priority && patch.priority !== current.priority) {
      await logActivity(tx, {
        workItemId: id,
        actorId: CURRENT_USER_ID,
        verb: 'priority_changed',
        detail: `set priority to ${patch.priority}`,
      });
    }
    if (patch.assigneeIds) {
      await validateAssigneeIds(tx, patch.assigneeIds);
      await logAssigneeChanges(tx, id, currentEnriched.assigneeIds, patch.assigneeIds);
      await tx.delete(workItemAssignees).where(eq(workItemAssignees.workItemId, id));
      if (patch.assigneeIds.length) {
        await tx.insert(workItemAssignees).values(
          patch.assigneeIds.map((assigneeId) => ({
            workItemId: id,
            assigneeId,
            assigneeKind: (assigneeId.startsWith('agent-') ? 'agent' : 'member') as 'agent' | 'member',
          })),
        );
      }
    }
    if (patch.labelIds) {
      await logLabelChanges(tx, id, currentEnriched.labelIds, patch.labelIds);
      await tx.delete(workItemLabels).where(eq(workItemLabels.workItemId, id));
      if (patch.labelIds.length) {
        await tx.insert(workItemLabels).values(patch.labelIds.map((labelId) => ({ workItemId: id, labelId })));
      }
    }
    if (patch.startDate !== undefined && patch.startDate && patch.startDate !== current.startDate) {
      await logActivity(tx, {
        workItemId: id,
        actorId: CURRENT_USER_ID,
        verb: 'start_date_set',
        detail: `set start date to ${patch.startDate}`,
      });
    }
    if (patch.dueDate !== undefined && patch.dueDate && patch.dueDate !== current.dueDate) {
      await logActivity(tx, {
        workItemId: id,
        actorId: CURRENT_USER_ID,
        verb: 'due_date_set',
        detail: `set due date to ${patch.dueDate}`,
      });
    }
    if (patch.parentId && patch.parentId !== current.parentId) {
      await logActivity(tx, {
        workItemId: patch.parentId,
        actorId: CURRENT_USER_ID,
        verb: 'sub_item_added',
        detail: `added ${current.identifier} as a sub-item`,
      });
    }

    const { assigneeIds, labelIds, estimatePoints, ...scalarPatch } = patch;
    const [row] = await tx
      .update(workItems)
      .set({
        ...scalarPatch,
        ...(estimatePoints !== undefined ? { estimatePoints: estimatePoints == null ? null : String(estimatePoints) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workItems.id, id))
      .returning();

    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

export async function toggleWorkItemAssignee(id: string, memberId: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(workItems).where(eq(workItems.id, id));
    if (!current) throw new NotFoundError('work item');
    const [{ assigneeIds: before }] = await attachRelations([current], tx);
    const adding = !before.includes(memberId);
    if (adding) await validateAssigneeIds(tx, [memberId]);
    const after = adding ? [...before, memberId] : before.filter((m) => m !== memberId);
    await logAssigneeChanges(tx, id, before, after);
    await tx.delete(workItemAssignees).where(eq(workItemAssignees.workItemId, id));
    if (after.length) {
      await tx.insert(workItemAssignees).values(
        after.map((assigneeId) => ({
          workItemId: id,
          assigneeId,
          assigneeKind: (assigneeId.startsWith('agent-') ? 'agent' : 'member') as 'agent' | 'member',
        })),
      );
    }
    await tx.update(workItems).set({ updatedAt: new Date() }).where(eq(workItems.id, id));
    const [row] = await tx.select().from(workItems).where(eq(workItems.id, id));
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

export async function toggleWorkItemLabel(id: string, labelId: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(workItems).where(eq(workItems.id, id));
    if (!current) throw new NotFoundError('work item');
    const [{ labelIds: before }] = await attachRelations([current], tx);
    const after = before.includes(labelId) ? before.filter((l) => l !== labelId) : [...before, labelId];
    await logLabelChanges(tx, id, before, after);
    await tx.delete(workItemLabels).where(eq(workItemLabels.workItemId, id));
    if (after.length) {
      await tx.insert(workItemLabels).values(after.map((lId) => ({ workItemId: id, labelId: lId })));
    }
    await tx.update(workItems).set({ updatedAt: new Date() }).where(eq(workItems.id, id));
    const [row] = await tx.select().from(workItems).where(eq(workItems.id, id));
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

// Fractional/lexo sort key: the DB equivalent of the mock's array-splice
// reorder. Computes the midpoint between the target row and its neighbor in
// its (possibly new) state, so list/board `ORDER BY sort_order` reproduces
// the drop position without touching every other row.
export async function reorderWorkItem(id: string, targetId: string, position: 'before' | 'after') {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(workItems).where(eq(workItems.id, id));
    const [target] = await tx.select().from(workItems).where(eq(workItems.id, targetId));
    if (!item || !target) throw new NotFoundError('work item');
    if (item.id === target.id) {
      const [enriched] = await attachRelations([item], tx);
      return enriched;
    }

    if (item.stateId !== target.stateId) {
      await logActivity(tx, { workItemId: id, actorId: CURRENT_USER_ID, verb: 'state_changed', detail: 'changed state' });
      await tx.update(workItems).set({ stateId: target.stateId, updatedAt: new Date() }).where(eq(workItems.id, id));
    }

    // target's own row/sortOrder never changes here — only item's does — so
    // target's state is still the right one to order siblings by.
    const siblings = await tx
      .select({ id: workItems.id, sortOrder: workItems.sortOrder })
      .from(workItems)
      .where(and(eq(workItems.stateId, target.stateId), ne(workItems.id, id)))
      .orderBy(asc(workItems.sortOrder));

    const targetIndex = siblings.findIndex((s) => s.id === targetId);
    const targetSort = Number(target.sortOrder);
    let newSort: number;
    if (position === 'before') {
      const prevSort = targetIndex > 0 ? Number(siblings[targetIndex - 1].sortOrder) : targetSort - 2000;
      newSort = (prevSort + targetSort) / 2;
    } else {
      const nextSort =
        targetIndex < siblings.length - 1 ? Number(siblings[targetIndex + 1].sortOrder) : targetSort + 2000;
      newSort = (targetSort + nextSort) / 2;
    }

    const [row] = await tx
      .update(workItems)
      .set({ sortOrder: String(newSort) })
      .where(eq(workItems.id, id))
      .returning();
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

export async function deleteWorkItem(id: string) {
  await db.delete(workItems).where(eq(workItems.id, id));
}

export async function addWorkItemLink(workItemId: string, input: { url: string; label: string }) {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(workItems).where(eq(workItems.id, workItemId));
    if (!item) throw new NotFoundError('work item');
    await tx.insert(workItemLinks).values({ id: newId('link'), workItemId, url: input.url, label: input.label });
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workItemLinks).where(eq(workItemLinks.workItemId, workItemId));
    await tx.update(workItems).set({ linkCount: n, updatedAt: new Date() }).where(eq(workItems.id, workItemId));
    await logActivity(tx, {
      workItemId,
      actorId: CURRENT_USER_ID,
      verb: 'link_added',
      detail: `added ${input.label || input.url} as a link`,
    });
    const [row] = await tx.select().from(workItems).where(eq(workItems.id, workItemId));
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

export async function removeWorkItemLink(workItemId: string, linkId: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx.select().from(workItemLinks).where(eq(workItemLinks.id, linkId));
    await tx.delete(workItemLinks).where(eq(workItemLinks.id, linkId));
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workItemLinks).where(eq(workItemLinks.workItemId, workItemId));
    const [row] = await tx
      .update(workItems)
      .set({ linkCount: n, updatedAt: new Date() })
      .where(eq(workItems.id, workItemId))
      .returning();
    if (!row) throw new NotFoundError('work item');
    if (link) {
      await logActivity(tx, {
        workItemId,
        actorId: CURRENT_USER_ID,
        verb: 'link_removed',
        detail: `removed ${link.label || link.url} as a link`,
      });
    }
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}
