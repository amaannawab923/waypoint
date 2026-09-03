import * as fs from 'fs';
import * as path from 'path';
import { eq, and, isNull, isNotNull, inArray } from 'drizzle-orm';
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

const DEFAULT_STATE_TEMPLATE = [
  { name: 'Backlog', group: 'backlog' as const, color: '#9c9280', sortOrder: 0 },
  { name: 'Todo', group: 'unstarted' as const, color: '#7d8a9c', sortOrder: 1 },
  { name: 'In Progress', group: 'started' as const, color: '#c99a2e', sortOrder: 2 },
  { name: 'Done', group: 'completed' as const, color: '#2f7a4f', sortOrder: 3 },
  { name: 'Cancelled', group: 'cancelled' as const, color: '#b7332a', sortOrder: 4 },
];

export async function listProjects() {
  const rows = await db.select().from(projects).where(isNull(projects.archivedAt));
  return attachMemberIds(rows);
}

export async function listArchivedProjects() {
  const rows = await db.select().from(projects).where(isNotNull(projects.archivedAt));
  return attachMemberIds(rows);
}

export async function getProject(id: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  if (!row) return undefined;
  return attachMemberIdsOne(row);
}

export interface CreateProjectInput {
  name: string;
  identifier: string;
  description?: string;
  icon?: string;
  network?: 'public' | 'private';
  leadId?: string | null;
}

export async function createProject(input: CreateProjectInput) {
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
        network: input.network ?? 'public',
        leadId: input.leadId ?? null,
        defaultAssigneeId: null,
        timezone: 'UTC',
        features: { sprints: false, workstreams: false, views: false, docs: true, requests: false },
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

    return toProjectEntity(project, [CURRENT_USER_ID]);
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

export async function updateProject(id: string, patch: Partial<typeof projects.$inferInsert>) {
  // An explicit `null` (unlink) skips validation entirely — clearing is
  // always safe, and a checkout that has since been deleted must still be
  // unlinkable.
  if (patch.repoPath) validateRepoPath(patch.repoPath);
  const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
  if (!row) throw new NotFoundError('project');
  return attachMemberIdsOne(row);
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
    return attachMemberIdsOne(row, tx);
  });
}

export async function updateProjectFeatures(id: string, patch: Record<string, boolean>) {
  const project = await getProject(id);
  if (!project) throw new NotFoundError('project');
  const features = { ...(project.features as object), ...patch };
  const [row] = await db.update(projects).set({ features }).where(eq(projects.id, id)).returning();
  return attachMemberIdsOne(row);
}

export async function updateProjectEstimate(id: string, estimate: { type: string; values: string[] } | null) {
  const [row] = await db.update(projects).set({ estimate }).where(eq(projects.id, id)).returning();
  if (!row) throw new NotFoundError('project');
  return attachMemberIdsOne(row);
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
  return attachMemberIdsOne(row);
}

export async function archiveProject(id: string) {
  const [row] = await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, id)).returning();
  if (!row) throw new NotFoundError('project');
}

export async function deleteProject(id: string) {
  const [row] = await db.delete(projects).where(eq(projects.id, id)).returning();
  if (!row) throw new NotFoundError('project');
}
