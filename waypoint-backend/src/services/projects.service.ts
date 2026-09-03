import * as fs from 'fs';
import * as path from 'path';
import { eq, and, isNull, isNotNull, inArray, sql, getTableColumns, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  projects,
  projectMembers,
  ticketStates,
  members,
  workstreams,
  workstreamMembers,
  sprints,
  sprintMembers,
  tickets,
  ticketAssignees,
  savedViews,
  docs,
  requests,
} from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { WORKSPACE_ID, CURRENT_USER_ID } from '../lib/currentUser.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ProjectRow = typeof projects.$inferSelect;
type ProjectEntity = Omit<ProjectRow, 'coverGradientStart' | 'coverGradientEnd'> & {
  memberIds: string[];
  coverGradient: [string, string];
};

// docs/design/waypoint-revamp-architecture.md §3.4 — nav presence is now
// derived from whether a primitive actually has rows, not a stored
// features flag. Keys are the primitive names post-rename.
export interface PrimitiveCounts {
  sprints: number;
  workstreams: number;
  views: number;
  docs: number;
  requests: number;
}
type ProjectWithCounts = ProjectEntity & { primitiveCounts: PrimitiveCounts };

// Two things every project response needs that the raw DB row doesn't
// provide on its own:
//   - memberIds: required on the client entity (entities.ts), read unguarded
//     by several pages (ticket detail, project lists, workstream detail) —
//     omitting it crashes those pages with `undefined.includes(...)`.
//   - coverGradient: the client entity declares this as a `[string,string]`
//     tuple; the DB stores it as two separate columns
//     (coverGradientStart/End) for a real schema, so it has to be
//     reassembled into a tuple here or those same pages crash again on
//     `undefined[0]`.
//
// Both take an optional executor so a caller inside db.transaction() can
// pass `tx` — reading via the plain `db` client from inside an open
// transaction hits a different connection and won't see that transaction's
// own uncommitted writes yet.
async function attachMemberIds(rows: ProjectRow[], executor: Tx | typeof db = db): Promise<ProjectEntity[]> {
  if (rows.length === 0) return [];
  const links = await executor
    .select()
    .from(projectMembers)
    .where(inArray(projectMembers.projectId, rows.map((r) => r.id)));
  const byProject = new Map<string, string[]>();
  for (const l of links) byProject.set(l.projectId, [...(byProject.get(l.projectId) ?? []), l.memberId]);
  return rows.map((r) => toProjectEntity(r, byProject.get(r.id) ?? []));
}
async function attachMemberIdsOne(row: ProjectRow, executor: Tx | typeof db = db): Promise<ProjectEntity> {
  const [withIds] = await attachMemberIds([row], executor);
  return withIds;
}
function toProjectEntity(row: ProjectRow, memberIds: string[]): ProjectEntity {
  const { coverGradientStart, coverGradientEnd, ...rest } = row;
  return { ...rest, memberIds, coverGradient: [coverGradientStart, coverGradientEnd] };
}

// Used by the single-project mutation return paths (create/update/member
// changes) — one project, so five small counts here is not the N+1 the list
// endpoint has to avoid. Tx-aware like attachMemberIds, for the same reason:
// a caller inside db.transaction() must read through `tx`, not a fresh `db`
// connection that can't see its own uncommitted writes yet. Each count is
// cast to int4 so the `postgres` driver hands back a real JS number rather
// than the string it uses for bigint/numeric (same reasoning as
// normalizeTicket's estimatePoints on the client side).
async function getPrimitiveCounts(projectId: string, executor: Tx | typeof db = db): Promise<PrimitiveCounts> {
  const [[sprintsRow], [workstreamsRow], [viewsRow], [docsRow], [requestsRow]] = await Promise.all([
    executor.select({ n: sql<number>`count(*)::int` }).from(sprints).where(eq(sprints.projectId, projectId)),
    executor.select({ n: sql<number>`count(*)::int` }).from(workstreams).where(eq(workstreams.projectId, projectId)),
    executor.select({ n: sql<number>`count(*)::int` }).from(savedViews).where(eq(savedViews.projectId, projectId)),
    executor.select({ n: sql<number>`count(*)::int` }).from(docs).where(eq(docs.projectId, projectId)),
    executor.select({ n: sql<number>`count(*)::int` }).from(requests).where(eq(requests.projectId, projectId)),
  ]);
  return {
    sprints: sprintsRow?.n ?? 0,
    workstreams: workstreamsRow?.n ?? 0,
    views: viewsRow?.n ?? 0,
    docs: docsRow?.n ?? 0,
    requests: requestsRow?.n ?? 0,
  };
}
async function withPrimitiveCounts(entity: ProjectEntity, executor: Tx | typeof db = db): Promise<ProjectWithCounts> {
  return { ...entity, primitiveCounts: await getPrimitiveCounts(entity.id, executor) };
}

// GET /projects (and friends) need every project's five primitive counts in
// one query, not one query per project per primitive — the sidebar renders
// every project. LEFT JOINing a GROUP BY subquery per primitive is the
// non-correlated equivalent of the LATERAL-join SQL in
// docs/design/waypoint-revamp-architecture.md §3.4 (a plain "count of rows
// per project" doesn't need LATERAL's per-outer-row correlation), expressed
// in this file's existing Drizzle query-builder style rather than a raw SQL
// escape hatch — there is no existing multi-join precedent elsewhere in
// this file or tickets.service.ts to match instead.
async function selectProjectsWithCounts(where: SQL | undefined): Promise<ProjectWithCounts[]> {
  // Each subquery's count column gets its own name (not a shared "n") —
  // Drizzle's outer SELECT list doesn't qualify these with their subquery
  // alias, so five identically-named columns from five joined subqueries
  // come out as an ambiguous bare "n" reference once Postgres parses it.
  const sprintsSub = db
    .select({ projectId: sprints.projectId, n: sql<number>`count(*)::int`.as('sprints_n') })
    .from(sprints)
    .groupBy(sprints.projectId)
    .as('sprint_counts');
  const workstreamsSub = db
    .select({ projectId: workstreams.projectId, n: sql<number>`count(*)::int`.as('workstreams_n') })
    .from(workstreams)
    .groupBy(workstreams.projectId)
    .as('workstream_counts');
  const viewsSub = db
    .select({ projectId: savedViews.projectId, n: sql<number>`count(*)::int`.as('views_n') })
    .from(savedViews)
    .groupBy(savedViews.projectId)
    .as('view_counts');
  const docsSub = db
    .select({ projectId: docs.projectId, n: sql<number>`count(*)::int`.as('docs_n') })
    .from(docs)
    .groupBy(docs.projectId)
    .as('doc_counts');
  const requestsSub = db
    .select({ projectId: requests.projectId, n: sql<number>`count(*)::int`.as('requests_n') })
    .from(requests)
    .groupBy(requests.projectId)
    .as('request_counts');

  // Plain column references, not a raw `coalesce(...)` sql fragment — a
  // LEFT JOIN with no matching group already leaves these NULL for a
  // project with zero rows in that primitive, which is exactly what "?? 0"
  // below handles; wrapping in sql`coalesce(...)` doesn't carry the
  // subquery's alias into the fragment, which is its own path to the same
  // ambiguous-column error.
  const rows = await db
    .select({
      ...getTableColumns(projects),
      sprintsCount: sprintsSub.n,
      workstreamsCount: workstreamsSub.n,
      viewsCount: viewsSub.n,
      docsCount: docsSub.n,
      requestsCount: requestsSub.n,
    })
    .from(projects)
    .leftJoin(sprintsSub, eq(sprintsSub.projectId, projects.id))
    .leftJoin(workstreamsSub, eq(workstreamsSub.projectId, projects.id))
    .leftJoin(viewsSub, eq(viewsSub.projectId, projects.id))
    .leftJoin(docsSub, eq(docsSub.projectId, projects.id))
    .leftJoin(requestsSub, eq(requestsSub.projectId, projects.id))
    .where(where);

  const bareRows: ProjectRow[] = rows.map(
    ({ sprintsCount: _s, workstreamsCount: _w, viewsCount: _v, docsCount: _d, requestsCount: _r, ...row }) =>
      row as ProjectRow,
  );
  const entities = await attachMemberIds(bareRows);
  return entities.map((entity, i) => ({
    ...entity,
    primitiveCounts: {
      sprints: rows[i].sprintsCount ?? 0,
      workstreams: rows[i].workstreamsCount ?? 0,
      views: rows[i].viewsCount ?? 0,
      docs: rows[i].docsCount ?? 0,
      requests: rows[i].requestsCount ?? 0,
    },
  }));
}

const DEFAULT_STATE_TEMPLATE = [
  { name: 'Backlog', group: 'backlog' as const, color: '#9c9280', sortOrder: 0 },
  { name: 'Todo', group: 'unstarted' as const, color: '#7d8a9c', sortOrder: 1 },
  { name: 'In Progress', group: 'started' as const, color: '#c99a2e', sortOrder: 2 },
  { name: 'Done', group: 'completed' as const, color: '#2f7a4f', sortOrder: 3 },
  { name: 'Cancelled', group: 'cancelled' as const, color: '#b7332a', sortOrder: 4 },
];

export async function listProjects(): Promise<ProjectWithCounts[]> {
  return selectProjectsWithCounts(isNull(projects.archivedAt));
}

export async function listArchivedProjects(): Promise<ProjectWithCounts[]> {
  return selectProjectsWithCounts(isNotNull(projects.archivedAt));
}

export async function getProject(id: string): Promise<ProjectWithCounts | undefined> {
  const [row] = await selectProjectsWithCounts(eq(projects.id, id));
  return row;
}

export interface CreateProjectInput {
  name: string;
  identifier: string;
  description?: string;
  icon?: string;
  visibility?: 'public' | 'private';
  leadId?: string | null;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectWithCounts> {
  const identifier = input.identifier.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'PROJ';
  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        id: newId('proj'),
        workspaceId: WORKSPACE_ID,
        name: input.name,
        identifier,
        description: input.description ?? '',
        icon: input.icon ?? '📦',
        coverGradientStart: '#c2542a',
        coverGradientEnd: '#3a2314',
        visibility: input.visibility ?? 'public',
        leadId: input.leadId ?? null,
        defaultAssigneeId: null,
        timezone: 'UTC',
        estimate: null,
        automations: {
          autoArchiveEnabled: false,
          autoArchiveAfterDays: 30,
          autoCloseEnabled: false,
          autoCloseAfterDays: 30,
        },
        guestAccessEnabled: false,
      })
      .returning();

    await tx.insert(ticketStates).values(
      DEFAULT_STATE_TEMPLATE.map((t) => ({
        id: newId('st'),
        projectId: project.id,
        name: t.name,
        group: t.group,
        color: t.color,
        isDefault: true,
        sortOrder: t.sortOrder,
      })),
    );

    // The creator is a member from the start — same as the original mock's
    // `memberIds: [d.currentUserId]` on creation.
    await tx.insert(projectMembers).values({ projectId: project.id, memberId: CURRENT_USER_ID });

    // A brand new project has no sprints/workstreams/views/docs/requests yet
    // (docs/design/waypoint-revamp-architecture.md §3.4) — no need to query
    // for what is necessarily all zero.
    return {
      ...toProjectEntity(project, [CURRENT_USER_ID]),
      primitiveCounts: { sprints: 0, workstreams: 0, views: 0, docs: 0, requests: 0 },
    };
  });
}

// The rules zod can't check in projects.schema.ts, because each needs a real
// `fs` call. That assumes this process runs on the same machine as the
// user's checkout — true for this app's local-first setup (the desktop
// client talks to localhost:14000, see the frontend's httpClient.ts), but
// observed rather than enforced anywhere, so a future remote-backend
// deployment has to revisit this.
export function validateRepoPath(repoPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch {
    throw new ValidationError(`repoPath does not exist: ${repoPath}`);
  }
  if (!stat.isDirectory()) {
    throw new ValidationError(`repoPath is not a directory: ${repoPath}`);
  }
  // existsSync, not statSync().isDirectory(): a worktree's ".git" is a
  // pointer FILE, not a directory, and both shapes are valid checkouts.
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new ValidationError(`repoPath is not a git repository: ${repoPath}`);
  }
}

export async function updateProject(
  id: string,
  patch: Partial<typeof projects.$inferInsert>,
): Promise<ProjectWithCounts> {
  // An explicit `null` (unlink) skips validation entirely — clearing is
  // always safe, and a checkout that has since been deleted must still be
  // unlinkable.
  if (patch.repoPath) validateRepoPath(patch.repoPath);
  const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
  if (!row) throw new NotFoundError('project');
  return withPrimitiveCounts(await attachMemberIdsOne(row));
}

// Preserves the original mock's behavior exactly: this mutates the member's
// GLOBAL role, not a project-scoped one — project_members has no role
// column. Worth confirming intent on separately; not "fixed" during the port.
export async function addProjectMember(projectId: string, memberId: string, role?: 'admin' | 'member' | 'guest') {
  await db
    .insert(projectMembers)
    .values({ projectId, memberId })
    .onConflictDoNothing();
  if (role) {
    await db.update(members).set({ role }).where(eq(members.id, memberId));
  }
  const project = await getProject(projectId);
  if (!project) throw new NotFoundError('project');
  return project;
}

export async function removeProjectMember(projectId: string, memberId: string) {
  return db.transaction(async (tx) => {
    await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.memberId, memberId)));

    // A removed member can't stay as project lead or default assignee —
    // otherwise those columns dangle on an id that's no longer a member,
    // and the settings UI's lead/assignee pickers silently fall back to
    // "none" without ever actually clearing the stored value.
    const [current] = await tx.select().from(projects).where(eq(projects.id, projectId));
    if (!current) throw new NotFoundError('project');
    const clears: Partial<typeof projects.$inferInsert> = {};
    if (current.leadId === memberId) clears.leadId = null;
    if (current.defaultAssigneeId === memberId) clears.defaultAssigneeId = null;
    if (Object.keys(clears).length) {
      await tx.update(projects).set(clears).where(eq(projects.id, projectId));
    }

    // Same dangling-reference problem exists one level down: this project's
    // own workstreams/sprints/tickets can still reference the removed member
    // as a lead or assignee. Scope every cleanup to this project only —
    // the member may still legitimately lead/be-assigned-in other projects.
    await tx
      .update(workstreams)
      .set({ leadId: null })
      .where(and(eq(workstreams.projectId, projectId), eq(workstreams.leadId, memberId)));
    await tx
      .delete(workstreamMembers)
      .where(
        and(
          eq(workstreamMembers.memberId, memberId),
          inArray(
            workstreamMembers.workstreamId,
            tx.select({ id: workstreams.id }).from(workstreams).where(eq(workstreams.projectId, projectId)),
          ),
        ),
      );
    await tx
      .update(sprints)
      .set({ leadId: null })
      .where(and(eq(sprints.projectId, projectId), eq(sprints.leadId, memberId)));
    await tx
      .delete(sprintMembers)
      .where(
        and(
          eq(sprintMembers.memberId, memberId),
          inArray(sprintMembers.sprintId, tx.select({ id: sprints.id }).from(sprints).where(eq(sprints.projectId, projectId))),
        ),
      );
    await tx
      .delete(ticketAssignees)
      .where(
        and(
          eq(ticketAssignees.assigneeId, memberId),
          inArray(ticketAssignees.ticketId, tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, projectId))),
        ),
      );

    const [row] = await tx.select().from(projects).where(eq(projects.id, projectId));
    return withPrimitiveCounts(await attachMemberIdsOne(row, tx), tx);
  });
}

export async function updateProjectEstimate(id: string, estimate: { type: string; values: string[] } | null) {
  const [row] = await db.update(projects).set({ estimate }).where(eq(projects.id, id)).returning();
  if (!row) throw new NotFoundError('project');
  return withPrimitiveCounts(await attachMemberIdsOne(row));
}

export async function getProjectAutomations(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new NotFoundError('project');
  return project.automations;
}

export async function updateProjectAutomations(id: string, patch: Record<string, unknown>) {
  const project = await getProject(id);
  if (!project) throw new NotFoundError('project');
  const automations = { ...(project.automations as object), ...patch };
  const [row] = await db.update(projects).set({ automations }).where(eq(projects.id, id)).returning();
  return withPrimitiveCounts(await attachMemberIdsOne(row));
}

export async function archiveProject(id: string) {
  const [row] = await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, id)).returning();
  if (!row) throw new NotFoundError('project');
}

export async function deleteProject(id: string) {
  const [row] = await db.delete(projects).where(eq(projects.id, id)).returning();
  if (!row) throw new NotFoundError('project');
}
