import { eq, and, or, ne, isNull, inArray, notInArray, asc, desc, sql, ilike, lte, gte, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  tickets,
  ticketLabels,
  ticketAssignees,
  ticketLinks,
  ticketStates,
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

// assigneeId is polymorphic (member OR agent, see tickets.ts schema
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
type TicketRow = typeof tickets.$inferSelect;
export type Enriched = TicketRow & { assigneeIds: string[]; labelIds: string[]; links: (typeof ticketLinks.$inferSelect)[] };

async function attachRelations(rows: TicketRow[], executor: Tx | typeof db = db): Promise<Enriched[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [labelRows, assigneeRows, linkRows] = await Promise.all([
    executor.select().from(ticketLabels).where(inArray(ticketLabels.ticketId, ids)),
    executor.select().from(ticketAssignees).where(inArray(ticketAssignees.ticketId, ids)),
    executor.select().from(ticketLinks).where(inArray(ticketLinks.ticketId, ids)),
  ]);
  const labelsByItem = new Map<string, string[]>();
  for (const l of labelRows) labelsByItem.set(l.ticketId, [...(labelsByItem.get(l.ticketId) ?? []), l.labelId]);
  const assigneesByItem = new Map<string, string[]>();
  for (const a of assigneeRows)
    assigneesByItem.set(a.ticketId, [...(assigneesByItem.get(a.ticketId) ?? []), a.assigneeId]);
  const linksByItem = new Map<string, (typeof ticketLinks.$inferSelect)[]>();
  for (const l of linkRows) linksByItem.set(l.ticketId, [...(linksByItem.get(l.ticketId) ?? []), l]);
  return rows.map((r) => ({
    ...r,
    assigneeIds: assigneesByItem.get(r.id) ?? [],
    labelIds: labelsByItem.get(r.id) ?? [],
    links: linksByItem.get(r.id) ?? [],
  }));
}

export interface TicketFilters {
  assigneeId?: string;
  stateId?: string;
  priority?: (typeof tickets.$inferInsert)['priority'];
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

// assigneeId can't just be pushed into the WHERE alongside the others —
// assignment is a separate many-to-many table (ticketAssignees), not a
// column on tickets — so it's expressed as a subquery passed directly to
// inArray(). Critically, this makes it participate in the SAME query as
// every other filter (stateId, priority, dueBefore) and the SAME single
// .limit(), applied once by the caller after ALL filters have narrowed the
// set together.
//
// This replaced an earlier version that resolved assigneeId as a separate,
// independently-limited pre-query run BEFORE the other filters ever got a
// chance to narrow anything down. That pre-query's own cap (bounded at
// filters.limit, or a fallback constant) was applied to the assignee's full
// candidate set — with no ORDER BY, so which rows survived the cap was
// nondeterministic — and then the main query's `truncated` signal was
// computed from what was already a short, upstream-truncated set. A caller
// asking for a heavy assignee's overdue items could get back an EMPTY,
// confidently-non-truncated result even when real matches existed, because
// the assignee's true matches were capped away before dueBefore ever ran.
// Folding this into the main query removes that failure mode entirely: the
// subquery has no LIMIT of its own, so it always contributes every one of
// the assignee's ticket ids to the AND'd condition set, and only the
// final, fully-filtered result is capped.
//
// No project-scoping is needed inside the subquery: for listTickets, the
// caller's own baseConditions already constrain the outer query to
// tickets.projectId, so intersecting with the (unscoped) assignee subquery
// via AND produces the same effective scoping as before, in one query.
//
// An assignee with zero items (or an unknown assigneeId) naturally yields
// zero matching rows — `tickets.id IN (<subquery with no rows>)` is valid
// SQL that simply never matches — so no separate "no possible matches"
// short-circuit is needed here; that was only ever an optimization for the
// old two-query shape, not a correctness requirement.
function withFilters(baseConditions: SQL[], filters: TicketFilters): SQL[] {
  const conditions = [...baseConditions];
  if (filters.stateId) conditions.push(eq(tickets.stateId, filters.stateId));
  if (filters.priority) conditions.push(eq(tickets.priority, filters.priority));
  if (filters.dueBefore) conditions.push(lte(tickets.dueDate, filters.dueBefore));
  if (filters.assigneeId) {
    conditions.push(
      inArray(
        tickets.id,
        db
          .select({ ticketId: ticketAssignees.ticketId })
          .from(ticketAssignees)
          .where(eq(ticketAssignees.assigneeId, filters.assigneeId)),
      ),
    );
  }
  return conditions;
}

export async function listTickets(projectId: string, filters: TicketFilters = {}) {
  const conditions = withFilters([eq(tickets.projectId, projectId), eq(tickets.isDraft, false)], filters);
  const query = db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .orderBy(asc(tickets.sortOrder));
  const rows = filters.limit ? await query.limit(filters.limit) : await query;
  return attachRelations(rows);
}

export async function listAllTickets(filters: TicketFilters = {}) {
  const conditions = withFilters([eq(tickets.isDraft, false)], filters);
  const query = db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .orderBy(asc(tickets.sortOrder));
  const rows = filters.limit ? await query.limit(filters.limit) : await query;
  return attachRelations(rows);
}

// The typed filter's domain-side shape (docs/design/waypoint-revamp-
// architecture.md §4.6). Deliberately a plain interface here rather than a
// re-export of validation/ticketFilter.schema.ts's zod-inferred type — this
// service layer never imports from validation/ anywhere else in this file
// (createTicket/updateTicket take their own CreateTicketInput/
// UpdateTicketPatch shapes too), so the route layer parses the wire filter
// with ticketFilterSchema and passes the resulting plain object in here.
// The array-element types are pulled from the Drizzle column types
// themselves so this can never drift out of sync with the actual enums.
export interface TicketFilterQuery {
  projectIds?: string[];
  stateIds?: string[];
  stateGroups?: (typeof ticketStates.$inferSelect)['group'][];
  // $inferSelect, not $inferInsert — the insert-side type of an enum
  // column with a default includes `| undefined` (fine for `eq()`, which
  // the untyped TicketFilters.priority above uses, but inArray() rejects
  // `undefined` array elements at the type level).
  priorities?: (typeof tickets.$inferSelect)['priority'][];
  // May contain literal member/agent ids plus the '@me' and '@unassigned'
  // sentinels — see buildAssigneeCondition.
  assigneeIds?: string[];
  labelIds?: string[];
  sprintIds?: string[];
  workstreamIds?: string[];
  sources?: (typeof tickets.$inferSelect)['source'][];
  // Absolute ISO date, or a relative day token like '-30d' — see
  // resolveFilterDate. Already shape-validated by ticketFilterSchema at the
  // route boundary; a token that fails to parse here is dropped rather than
  // thrown, matching this file's general "bad optional input degrades
  // instead of 500s" posture (see escapeLikePattern's comment for the same
  // idea applied to search).
  updatedBefore?: string;
  createdAfter?: string;
  text?: string;
  // Drafts are excluded by default, matching listDraftTickets'
  // CURRENT_USER_ID-scoped listing and the MCP list tools' own
  // exclude-drafts-by-default convention. Set true to include them.
  includeDrafts?: boolean;
}

const RELATIVE_DAY_TOKEN_RE = /^-(\d+)d$/;

function resolveFilterDate(token: string): Date | undefined {
  const relative = RELATIVE_DAY_TOKEN_RE.exec(token);
  if (relative) return new Date(Date.now() - Number(relative[1]) * 86_400_000);
  const parsed = new Date(token);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// assigneeIds is OR'd within itself like every other multi-value filter
// field (array-contains semantics), but two of its possible entries aren't
// plain ids: '@me' resolves to the current user (so a saved view means "my
// tickets" for whoever opens it, not whoever saved it) and '@unassigned'
// means "has zero assignees" — an empty-set condition that can't be
// expressed as a positive id match, so it gets its own NOT IN subquery,
// OR'd together with the specific-id condition when both are present.
function buildAssigneeCondition(rawIds: string[]): SQL | undefined {
  const ids = new Set(rawIds);
  const wantsUnassigned = ids.delete('@unassigned');
  if (ids.delete('@me')) ids.add(CURRENT_USER_ID);
  const specificIds = [...ids];

  const specificCondition = specificIds.length
    ? inArray(
        tickets.id,
        db.select({ ticketId: ticketAssignees.ticketId }).from(ticketAssignees).where(inArray(ticketAssignees.assigneeId, specificIds)),
      )
    : undefined;
  const unassignedCondition = wantsUnassigned
    ? notInArray(tickets.id, db.select({ ticketId: ticketAssignees.ticketId }).from(ticketAssignees))
    : undefined;

  if (specificCondition && unassignedCondition) return or(specificCondition, unassignedCondition);
  return specificCondition ?? unassignedCondition;
}

function buildLabelCondition(labelIds: string[]): SQL {
  return inArray(
    tickets.id,
    db.select({ ticketId: ticketLabels.ticketId }).from(ticketLabels).where(inArray(ticketLabels.labelId, labelIds)),
  );
}

// stateGroup lives on ticket_states, not tickets itself, so it's expressed
// the same way assigneeId/labelId are: a subquery passed to inArray()
// rather than a join, keeping this condition combinable with everything
// else in one and(...) via the same pattern withFilters/buildAssigneeCondition
// already use.
function buildStateGroupCondition(groups: (typeof ticketStates.$inferSelect)['group'][]): SQL {
  return inArray(
    tickets.stateId,
    db.select({ id: ticketStates.id }).from(ticketStates).where(inArray(ticketStates.group, groups)),
  );
}

export function buildTypedFilterConditions(query: TicketFilterQuery): SQL[] {
  const conditions: SQL[] = [];
  if (!query.includeDrafts) conditions.push(eq(tickets.isDraft, false));
  if (query.projectIds?.length) conditions.push(inArray(tickets.projectId, query.projectIds));
  if (query.stateIds?.length) conditions.push(inArray(tickets.stateId, query.stateIds));
  if (query.stateGroups?.length) conditions.push(buildStateGroupCondition(query.stateGroups));
  if (query.priorities?.length) conditions.push(inArray(tickets.priority, query.priorities));
  if (query.sources?.length) conditions.push(inArray(tickets.source, query.sources));
  if (query.workstreamIds?.length) conditions.push(inArray(tickets.workstreamId, query.workstreamIds));
  if (query.sprintIds?.length) conditions.push(inArray(tickets.sprintId, query.sprintIds));
  if (query.labelIds?.length) conditions.push(buildLabelCondition(query.labelIds));
  if (query.assigneeIds?.length) {
    const condition = buildAssigneeCondition(query.assigneeIds);
    if (condition) conditions.push(condition);
  }
  if (query.updatedBefore) {
    const date = resolveFilterDate(query.updatedBefore);
    if (date) conditions.push(lte(tickets.updatedAt, date));
  }
  if (query.createdAfter) {
    const date = resolveFilterDate(query.createdAfter);
    if (date) conditions.push(gte(tickets.createdAt, date));
  }
  if (query.text) conditions.push(ilike(tickets.title, `%${escapeLikePattern(query.text)}%`));
  return conditions;
}

// The single read path behind GET /tickets?filter=<base64url> and
// GET /projects/:projectId/tickets?filter=<base64url> (routes/tickets.routes.ts
// decodes and validates the wire filter, then narrows projectIds to the
// path param for the project-scoped route). This is deliberately the only
// place typed-filter conditions turn into a query — useTicketsView.ts no
// longer filters client-side, and Calendar/Spreadsheet/Gantt share the same
// hook instance as List/Board, so there is exactly one place filtering can
// (or can fail to) happen.
export async function listTicketsByFilter(query: TicketFilterQuery) {
  const conditions = buildTypedFilterConditions(query);
  const rows = await db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .orderBy(asc(tickets.sortOrder));
  return attachRelations(rows);
}

// Title-only match for now — description/identifier matching is a
// reasonable fast-follow, not silently promised here.
export async function searchTickets(query: string, projectId?: string, limit?: number) {
  const conditions = [eq(tickets.isDraft, false), ilike(tickets.title, `%${escapeLikePattern(query)}%`)];
  if (projectId) conditions.push(eq(tickets.projectId, projectId));
  const dbQuery = db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .orderBy(asc(tickets.sortOrder));
  const rows = limit ? await dbQuery.limit(limit) : await dbQuery;
  return attachRelations(rows);
}

export async function listDraftTickets() {
  const rows = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.isDraft, true), eq(tickets.createdById, CURRENT_USER_ID)));
  return attachRelations(rows);
}

export async function getTicket(id: string) {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, id));
  if (!row) return undefined;
  const [enriched] = await attachRelations([row]);
  return enriched;
}

// Cheap draft/existence check for callers (e.g. listCommentsHandler/
// listActivityHandler in ticketTools.ts) that only need to know whether a
// ticket is missing or a draft before proceeding — not its full enriched
// record. getTicket() does the main select plus three relation joins
// (labels/assignees/links) via attachRelations(), which is wasted work when
// all that's needed is one boolean. Returns true for "missing" as well as
// "draft" so callers can use a single check for both "not found" and
// "hidden because it's a draft" cases, matching how those callers already
// treat both as the same not-found result.
export async function isTicketDraftOrMissing(id: string): Promise<boolean> {
  const [row] = await db.select({ isDraft: tickets.isDraft }).from(tickets).where(eq(tickets.id, id));
  return !row || row.isDraft;
}

export async function getTicketByIdentifier(identifier: string) {
  const [row] = await db.select().from(tickets).where(eq(tickets.identifier, identifier));
  if (!row) return undefined;
  const [enriched] = await attachRelations([row]);
  return enriched;
}

export async function listSubItems(parentId: string) {
  const rows = await db.select().from(tickets).where(eq(tickets.parentId, parentId));
  return attachRelations(rows);
}

export interface CreateTicketInput {
  projectId: string;
  title: string;
  description?: string;
  stateId: string;
  priority?: (typeof tickets.$inferInsert)['priority'];
  assigneeIds?: string[];
  labelIds?: string[];
  workstreamId?: string | null;
  sprintId?: string | null;
  parentId?: string | null;
  isDraft?: boolean;
  // Provenance (§3.3). Defaults to 'manual' — only callers that know
  // otherwise, like a converted request, pass anything else.
  source?: (typeof tickets.$inferInsert)['source'];
}

export async function createTicket(input: CreateTicketInput) {
  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId));
    // Lock the project's existing rows to serialize sequenceId allocation
    // under concurrent requests — the mock's Math.max(...)+1 was only safe
    // single-threaded; a unique(project_id, sequence_id) constraint backs
    // this up if two requests still race.
    const existing = await tx
      .select({ sequenceId: tickets.sequenceId, sortOrder: tickets.sortOrder })
      .from(tickets)
      .where(eq(tickets.projectId, input.projectId))
      .orderBy(desc(tickets.sequenceId))
      .limit(1)
      .for('update');
    const nextSeq = (existing[0]?.sequenceId ?? 0) + 1;
    const maxSortOrder = existing[0]?.sortOrder ? Number(existing[0].sortOrder) : 0;

    const [row] = await tx
      .insert(tickets)
      .values({
        id: newId('wi'),
        projectId: input.projectId,
        identifier: `${project?.identifier ?? 'WI'}-${nextSeq}`,
        sequenceId: nextSeq,
        title: input.title,
        description: input.description ?? '',
        stateId: input.stateId,
        priority: input.priority ?? 'none',
        source: input.source ?? 'manual',
        workstreamId: input.workstreamId ?? null,
        sprintId: input.sprintId ?? null,
        parentId: input.parentId ?? null,
        createdById: CURRENT_USER_ID,
        isDraft: input.isDraft ?? false,
        sortOrder: String(maxSortOrder + 1000),
      })
      .returning();

    if (input.assigneeIds?.length) {
      await validateAssigneeIds(tx, input.assigneeIds);
      await tx.insert(ticketAssignees).values(
        input.assigneeIds.map((assigneeId) => ({
          ticketId: row.id,
          assigneeId,
          assigneeKind: (assigneeId.startsWith('agent-') ? 'agent' : 'member') as 'agent' | 'member',
        })),
      );
    }
    if (input.labelIds?.length) {
      await tx.insert(ticketLabels).values(input.labelIds.map((labelId) => ({ ticketId: row.id, labelId })));
    }

    await logActivity(tx, {
      ticketId: row.id,
      actorId: CURRENT_USER_ID,
      verb: 'created',
      detail: 'created the ticket',
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

async function logAssigneeChanges(tx: Tx, ticketId: string, beforeIds: string[], afterIds: string[]) {
  const before = new Set(beforeIds);
  const after = new Set(afterIds);
  for (const id of afterIds.filter((a) => !before.has(a))) {
    await logActivity(tx, {
      ticketId,
      actorId: CURRENT_USER_ID,
      verb: 'assignee_added',
      detail: `added ${(await nameForActor(tx, id)) ?? 'an assignee'} as assignee`,
    });
  }
  for (const id of beforeIds.filter((b) => !after.has(b))) {
    await logActivity(tx, {
      ticketId,
      actorId: CURRENT_USER_ID,
      verb: 'assignee_removed',
      detail: `removed ${(await nameForActor(tx, id)) ?? 'an assignee'} as assignee`,
    });
  }
}

async function logLabelChanges(tx: Tx, ticketId: string, beforeIds: string[], afterIds: string[]) {
  const before = new Set(beforeIds);
  const after = new Set(afterIds);
  for (const id of afterIds.filter((l) => !before.has(l))) {
    const [label] = await tx.select().from(labels).where(eq(labels.id, id));
    await logActivity(tx, {
      ticketId,
      actorId: CURRENT_USER_ID,
      verb: 'label_added',
      detail: `added ${label?.name ?? 'a label'} as a label`,
    });
  }
  for (const id of beforeIds.filter((b) => !after.has(b))) {
    const [label] = await tx.select().from(labels).where(eq(labels.id, id));
    await logActivity(tx, {
      ticketId,
      actorId: CURRENT_USER_ID,
      verb: 'label_removed',
      detail: `removed ${label?.name ?? 'a label'} as a label`,
    });
  }
}

export interface UpdateTicketPatch {
  title?: string;
  description?: string;
  stateId?: string;
  priority?: (typeof tickets.$inferInsert)['priority'];
  assigneeIds?: string[];
  labelIds?: string[];
  workstreamId?: string | null;
  sprintId?: string | null;
  parentId?: string | null;
  estimatePoints?: number | null;
  estimateValue?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  isDraft?: boolean;
}

export async function updateTicket(id: string, patch: UpdateTicketPatch) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(tickets).where(eq(tickets.id, id));
    if (!current) throw new NotFoundError('ticket');
    const [currentEnriched] = await attachRelations([current], tx);

    const stateChanged = Boolean(patch.stateId && patch.stateId !== current.stateId);
    if (stateChanged) {
      await logActivity(tx, { ticketId: id, actorId: CURRENT_USER_ID, verb: 'state_changed', detail: 'changed state' });
    }
    if (patch.priority && patch.priority !== current.priority) {
      await logActivity(tx, {
        ticketId: id,
        actorId: CURRENT_USER_ID,
        verb: 'priority_changed',
        detail: `set priority to ${patch.priority}`,
      });
    }
    if (patch.assigneeIds) {
      await validateAssigneeIds(tx, patch.assigneeIds);
      await logAssigneeChanges(tx, id, currentEnriched.assigneeIds, patch.assigneeIds);
      await tx.delete(ticketAssignees).where(eq(ticketAssignees.ticketId, id));
      if (patch.assigneeIds.length) {
        await tx.insert(ticketAssignees).values(
          patch.assigneeIds.map((assigneeId) => ({
            ticketId: id,
            assigneeId,
            assigneeKind: (assigneeId.startsWith('agent-') ? 'agent' : 'member') as 'agent' | 'member',
          })),
        );
      }
    }
    if (patch.labelIds) {
      await logLabelChanges(tx, id, currentEnriched.labelIds, patch.labelIds);
      await tx.delete(ticketLabels).where(eq(ticketLabels.ticketId, id));
      if (patch.labelIds.length) {
        await tx.insert(ticketLabels).values(patch.labelIds.map((labelId) => ({ ticketId: id, labelId })));
      }
    }
    if (patch.startDate !== undefined && patch.startDate && patch.startDate !== current.startDate) {
      await logActivity(tx, {
        ticketId: id,
        actorId: CURRENT_USER_ID,
        verb: 'start_date_set',
        detail: `set start date to ${patch.startDate}`,
      });
    }
    if (patch.dueDate !== undefined && patch.dueDate && patch.dueDate !== current.dueDate) {
      await logActivity(tx, {
        ticketId: id,
        actorId: CURRENT_USER_ID,
        verb: 'due_date_set',
        detail: `set due date to ${patch.dueDate}`,
      });
    }
    if (patch.parentId && patch.parentId !== current.parentId) {
      await logActivity(tx, {
        ticketId: patch.parentId,
        actorId: CURRENT_USER_ID,
        verb: 'sub_item_added',
        detail: `added ${current.identifier} as a sub-item`,
      });
    }

    const { assigneeIds, labelIds, estimatePoints, ...scalarPatch } = patch;
    const [row] = await tx
      .update(tickets)
      .set({
        ...scalarPatch,
        ...(estimatePoints !== undefined ? { estimatePoints: estimatePoints == null ? null : String(estimatePoints) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, id))
      .returning();

    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

export async function toggleTicketAssignee(id: string, memberId: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(tickets).where(eq(tickets.id, id));
    if (!current) throw new NotFoundError('ticket');
    const [{ assigneeIds: before }] = await attachRelations([current], tx);
    const adding = !before.includes(memberId);
    if (adding) await validateAssigneeIds(tx, [memberId]);
    const after = adding ? [...before, memberId] : before.filter((m) => m !== memberId);
    await logAssigneeChanges(tx, id, before, after);
    await tx.delete(ticketAssignees).where(eq(ticketAssignees.ticketId, id));
    if (after.length) {
      await tx.insert(ticketAssignees).values(
        after.map((assigneeId) => ({
          ticketId: id,
          assigneeId,
          assigneeKind: (assigneeId.startsWith('agent-') ? 'agent' : 'member') as 'agent' | 'member',
        })),
      );
    }
    await tx.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, id));
    const [row] = await tx.select().from(tickets).where(eq(tickets.id, id));
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

export async function toggleTicketLabel(id: string, labelId: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(tickets).where(eq(tickets.id, id));
    if (!current) throw new NotFoundError('ticket');
    const [{ labelIds: before }] = await attachRelations([current], tx);
    const after = before.includes(labelId) ? before.filter((l) => l !== labelId) : [...before, labelId];
    await logLabelChanges(tx, id, before, after);
    await tx.delete(ticketLabels).where(eq(ticketLabels.ticketId, id));
    if (after.length) {
      await tx.insert(ticketLabels).values(after.map((lId) => ({ ticketId: id, labelId: lId })));
    }
    await tx.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, id));
    const [row] = await tx.select().from(tickets).where(eq(tickets.id, id));
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

// Fractional/lexo sort key: the DB equivalent of the mock's array-splice
// reorder. Computes the midpoint between the target row and its neighbor in
// its (possibly new) state, so list/board `ORDER BY sort_order` reproduces
// the drop position without touching every other row.
export async function reorderTicket(id: string, targetId: string, position: 'before' | 'after') {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(tickets).where(eq(tickets.id, id));
    const [target] = await tx.select().from(tickets).where(eq(tickets.id, targetId));
    if (!item || !target) throw new NotFoundError('ticket');
    if (item.id === target.id) {
      const [enriched] = await attachRelations([item], tx);
      return enriched;
    }

    if (item.stateId !== target.stateId) {
      await logActivity(tx, { ticketId: id, actorId: CURRENT_USER_ID, verb: 'state_changed', detail: 'changed state' });
      await tx.update(tickets).set({ stateId: target.stateId, updatedAt: new Date() }).where(eq(tickets.id, id));
    }

    // target's own row/sortOrder never changes here — only item's does — so
    // target's state is still the right one to order siblings by.
    const siblings = await tx
      .select({ id: tickets.id, sortOrder: tickets.sortOrder })
      .from(tickets)
      .where(and(eq(tickets.stateId, target.stateId), ne(tickets.id, id)))
      .orderBy(asc(tickets.sortOrder));

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
      .update(tickets)
      .set({ sortOrder: String(newSort) })
      .where(eq(tickets.id, id))
      .returning();
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

export async function deleteTicket(id: string) {
  await db.delete(tickets).where(eq(tickets.id, id));
}

export async function addTicketLink(ticketId: string, input: { url: string; label: string }) {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!item) throw new NotFoundError('ticket');
    await tx.insert(ticketLinks).values({ id: newId('link'), ticketId, url: input.url, label: input.label });
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(ticketLinks).where(eq(ticketLinks.ticketId, ticketId));
    await tx.update(tickets).set({ linkCount: n, updatedAt: new Date() }).where(eq(tickets.id, ticketId));
    await logActivity(tx, {
      ticketId,
      actorId: CURRENT_USER_ID,
      verb: 'link_added',
      detail: `added ${input.label || input.url} as a link`,
    });
    const [row] = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}

export async function removeTicketLink(ticketId: string, linkId: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx.select().from(ticketLinks).where(eq(ticketLinks.id, linkId));
    await tx.delete(ticketLinks).where(eq(ticketLinks.id, linkId));
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(ticketLinks).where(eq(ticketLinks.ticketId, ticketId));
    const [row] = await tx
      .update(tickets)
      .set({ linkCount: n, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId))
      .returning();
    if (!row) throw new NotFoundError('ticket');
    if (link) {
      await logActivity(tx, {
        ticketId,
        actorId: CURRENT_USER_ID,
        verb: 'link_removed',
        detail: `removed ${link.label || link.url} as a link`,
      });
    }
    const [enriched] = await attachRelations([row], tx);
    return enriched;
  });
}
