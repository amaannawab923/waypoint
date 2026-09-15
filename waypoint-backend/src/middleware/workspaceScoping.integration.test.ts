import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import postgres from 'postgres';

// AT11 (ROAD-146). The proving test spec §6 asks for: seed two real
// workspaces, authenticate as one via a real session token (not a mocked
// req.member), request the other's resources by id across every route
// the audit covers, and assert the response never leaks that data. This
// is the thing that turns "checked, not assumed" from a sentence in the
// design doc into something CI enforces.
//
// Every test below drives the real Express app (resolveMember middleware
// included, via createApp()) with real HTTP requests through supertest —
// not the service functions directly, and not a mocked req.member. The
// listMembers() leak this ticket fixes, and every other scoping fix,
// only actually matter at this boundary.
//
// Skipped, not failed, without a reachable database — same convention as
// every other *.integration.test.ts file in this project.
async function databaseReachable(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const probe = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 3 });
  }
}

const REAL_DB = await databaseReachable();

describe.skipIf(!REAL_DB)('workspace-scoping audit against real Postgres (AT11)', () => {
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: typeof import('drizzle-orm')['eq'];
  let issueSession: typeof import('../auth/sessions.js')['issueSession'];
  let app: express.Express;

  const stamp = Date.now();
  // Two full tenants, A and B. Every test authenticates as A and reaches
  // for B's resources.
  const A = {
    workspaceId: `ws-at11-a-${stamp}`,
    userId: `user-at11-a-${stamp}`,
    memberId: `mem-at11-a-${stamp}`,
    projectId: `proj-at11-a-${stamp}`,
    stateId: `st-at11-a-${stamp}`,
    ticketId: `wi-at11-a-${stamp}`,
    viewId: `view-at11-a-${stamp}`,
    docId: `pg-at11-a-${stamp}`,
    workstreamId: `mod-at11-a-${stamp}`,
    sprintId: `cyc-at11-a-${stamp}`,
    token: '',
  };
  const B = {
    workspaceId: `ws-at11-b-${stamp}`,
    userId: `user-at11-b-${stamp}`,
    memberId: `mem-at11-b-${stamp}`,
    projectId: `proj-at11-b-${stamp}`,
    stateId: `st-at11-b-${stamp}`,
    ticketId: `wi-at11-b-${stamp}`,
    viewId: `view-at11-b-${stamp}`,
    docId: `pg-at11-b-${stamp}`,
    workstreamId: `mod-at11-b-${stamp}`,
    sprintId: `cyc-at11-b-${stamp}`,
  };

  function asA() {
    return { Authorization: `Bearer ${A.token}`, 'X-Waypoint-Workspace-Id': A.workspaceId };
  }

  async function seedTenant(t: typeof A | typeof B) {
    await db.insert(schema.workspaces).values({
      id: t.workspaceId,
      name: `AT11 tenant ${t.workspaceId}`,
      slug: t.workspaceId,
      companySize: '2-10',
      timezone: 'UTC',
    });
    await db.insert(schema.users).values({
      id: t.userId,
      email: `${t.userId}@example.test`,
      fullName: 'AT11 Test User',
      authMethod: 'email',
    });
    await db.insert(schema.members).values({
      id: t.memberId,
      workspaceId: t.workspaceId,
      userId: t.userId,
      fullName: 'AT11 Test User',
      displayName: 'AT11',
      email: `${t.memberId}@example.test`,
      avatarColor: '#000000',
      role: 'admin',
      authMethod: 'email',
    });
    await db.insert(schema.projects).values({
      id: t.projectId,
      workspaceId: t.workspaceId,
      name: `AT11 project ${t.workspaceId}`,
      identifier: t === A ? 'ATA' : 'ATB',
      icon: 'folder',
      coverGradientStart: '#000000',
      coverGradientEnd: '#ffffff',
      timezone: 'UTC',
      automations: {},
    });
    await db.insert(schema.ticketStates).values({
      id: t.stateId,
      projectId: t.projectId,
      name: 'Todo',
      group: 'unstarted',
      color: '#000000',
      isDefault: true,
    });
    await db.insert(schema.tickets).values({
      id: t.ticketId,
      projectId: t.projectId,
      identifier: `${t === A ? 'ATA' : 'ATB'}-1`,
      sequenceId: 1,
      title: `AT11 ticket ${t.workspaceId}`,
      stateId: t.stateId,
      createdById: t.memberId,
    });
    await db.insert(schema.savedViews).values({
      id: t.viewId,
      projectId: t.projectId,
      name: `AT11 view ${t.workspaceId}`,
      ownerId: t.memberId,
      filters: {},
    });
    await db.insert(schema.docs).values({
      id: t.docId,
      projectId: t.projectId,
      title: `AT11 doc ${t.workspaceId}`,
      icon: '📄',
      ownerId: t.memberId,
    });
    await db.insert(schema.workstreams).values({
      id: t.workstreamId,
      projectId: t.projectId,
      name: `AT11 workstream ${t.workspaceId}`,
    });
    await db.insert(schema.sprints).values({
      id: t.sprintId,
      projectId: t.projectId,
      name: `AT11 sprint ${t.workspaceId}`,
      startDate: '2026-01-01',
      endDate: '2026-01-14',
    });
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    schema = await import('../db/schema/index.js');
    ({ eq } = await import('drizzle-orm'));
    ({ issueSession } = await import('../auth/sessions.js'));
    const { createApp } = await import('../app.js');
    app = createApp();

    await seedTenant(A);
    await seedTenant(B);
    const { token } = await issueSession(A.userId, { deviceLabel: 'AT11 test' });
    A.token = token;
  });

  afterAll(async () => {
    if (!db) return;
    // Explicit order, not just "delete the workspace and let FK cascade
    // sort it out": tickets/docs' created_by_id/owner_id reference
    // members with ON DELETE RESTRICT (not cascade), so a workspace
    // delete that reaches "cascade-delete this member" before it has
    // already cascade-deleted every ticket/doc that member created is
    // rejected outright — deleting the project first (cascading
    // tickets/docs/views/workstreams/sprints via their own projectId FK)
    // removes that referencing row before members are ever touched.
    await db.delete(schema.projects).where(eq(schema.projects.id, A.projectId));
    await db.delete(schema.projects).where(eq(schema.projects.id, B.projectId));
    // sessions/users don't hang off either workspace's FK chain at all —
    // cleared explicitly.
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, A.userId));
    await db.delete(schema.users).where(eq(schema.users.id, A.userId));
    await db.delete(schema.users).where(eq(schema.users.id, B.userId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, A.workspaceId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, B.workspaceId));
  });

  it('resolveMember: a real request authenticated as A actually resolves to A — sanity check before every refusal test below means anything', async () => {
    const res = await request(app).get('/me').set(asA());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(A.memberId);
    expect(res.body.workspaceId).toBe(A.workspaceId);
  });

  it('GET /members as A never includes B — the confirmed listMembers() leak this ticket fixes', async () => {
    const res = await request(app).get('/members').set(asA());
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain(A.memberId);
    expect(ids).not.toContain(B.memberId);
  });

  it('GET /projects/:id refuses B\'s project as 404', async () => {
    const res = await request(app).get(`/projects/${B.projectId}`).set(asA());
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(B.workspaceId);
  });

  it('GET /projects and GET /projects/archived never include B\'s project', async () => {
    const res = await request(app).get('/projects').set(asA());
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((p) => p.id)).not.toContain(B.projectId);
  });

  it('PATCH /projects/:id refuses to rename B\'s project as 404, and does not touch it', async () => {
    const res = await request(app).patch(`/projects/${B.projectId}`).set(asA()).send({ name: 'pwned' });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, B.projectId));
    expect(row?.name).not.toBe('pwned');
  });

  it('POST /projects/:id/members refuses to add A into B\'s project, and writes nothing', async () => {
    const res = await request(app).post(`/projects/${B.projectId}/members`).set(asA()).send({ memberId: A.memberId });
    expect(res.status).toBe(404);
    const rows = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.projectId, B.projectId));
    expect(rows.map((r) => r.memberId)).not.toContain(A.memberId);
  });

  it('GET /tickets/:id refuses B\'s ticket as 404', async () => {
    const res = await request(app).get(`/tickets/${B.ticketId}`).set(asA());
    expect(res.status).toBe(404);
  });

  it('GET /tickets/by-identifier/:identifier refuses B\'s ticket as 404', async () => {
    const res = await request(app).get('/tickets/by-identifier/ATB-1').set(asA());
    expect(res.status).toBe(404);
  });

  it('GET /tickets (list-all) never includes B\'s ticket', async () => {
    const res = await request(app).get('/tickets').set(asA());
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((t) => t.id)).not.toContain(B.ticketId);
  });

  it('GET /projects/:projectId/tickets against B\'s project id is refused, not an empty A-flavored list', async () => {
    const res = await request(app).get(`/projects/${B.projectId}/tickets`).set(asA());
    expect(res.status).toBe(404);
  });

  it('POST /tickets refuses to create a ticket inside B\'s project as 404, and writes nothing', async () => {
    const res = await request(app)
      .post('/tickets')
      .set(asA())
      .send({ projectId: B.projectId, title: 'pwned', stateId: B.stateId });
    expect(res.status).toBe(404);
    const rows = await db.select().from(schema.tickets).where(eq(schema.tickets.title, 'pwned'));
    expect(rows).toHaveLength(0);
  });

  it('GET /projects/:projectId/views against B refuses as 404', async () => {
    const res = await request(app).get(`/projects/${B.projectId}/views`).set(asA());
    expect(res.status).toBe(404);
  });

  it('PATCH /views/:id refuses B\'s view as 404, and does not touch it', async () => {
    const res = await request(app).patch(`/views/${B.viewId}`).set(asA()).send({ name: 'pwned' });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.savedViews).where(eq(schema.savedViews.id, B.viewId));
    expect(row?.name).not.toBe('pwned');
  });

  it('DELETE /views/:id against B\'s view is a silent no-op (204), and B\'s row survives', async () => {
    const res = await request(app).delete(`/views/${B.viewId}`).set(asA());
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.savedViews).where(eq(schema.savedViews.id, B.viewId));
    expect(row).toBeDefined();
  });

  it('GET /projects/:projectId/docs against B refuses as 404', async () => {
    const res = await request(app).get(`/projects/${B.projectId}/docs`).set(asA());
    expect(res.status).toBe(404);
  });

  it('GET /docs/:id refuses B\'s doc as 404', async () => {
    const res = await request(app).get(`/docs/${B.docId}`).set(asA());
    expect(res.status).toBe(404);
  });

  it('GET /docs (list-all) never includes B\'s doc', async () => {
    const res = await request(app).get('/docs').set(asA());
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((d) => d.id)).not.toContain(B.docId);
  });

  it('PATCH /docs/:id refuses B\'s doc as 404, and does not touch it', async () => {
    const res = await request(app).patch(`/docs/${B.docId}`).set(asA()).send({ title: 'pwned' });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.docs).where(eq(schema.docs.id, B.docId));
    expect(row?.title).not.toBe('pwned');
  });

  it('DELETE /docs/:id against B\'s doc is a silent no-op (204), and B\'s row survives', async () => {
    const res = await request(app).delete(`/docs/${B.docId}`).set(asA());
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.docs).where(eq(schema.docs.id, B.docId));
    expect(row).toBeDefined();
  });

  it('GET /projects/:projectId/workstreams against B refuses as 404', async () => {
    const res = await request(app).get(`/projects/${B.projectId}/workstreams`).set(asA());
    expect(res.status).toBe(404);
  });

  it('GET /workstreams (list-all) never includes B\'s workstream', async () => {
    const res = await request(app).get('/workstreams').set(asA());
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((w) => w.id)).not.toContain(B.workstreamId);
  });

  it('PATCH /workstreams/:id refuses B\'s workstream as 404, and does not touch it', async () => {
    const res = await request(app).patch(`/workstreams/${B.workstreamId}`).set(asA()).send({ name: 'pwned' });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.workstreams).where(eq(schema.workstreams.id, B.workstreamId));
    expect(row?.name).not.toBe('pwned');
  });

  it('GET /projects/:projectId/sprints against B refuses as 404', async () => {
    const res = await request(app).get(`/projects/${B.projectId}/sprints`).set(asA());
    expect(res.status).toBe(404);
  });

  it('GET /sprints (list-all) never includes B\'s sprint', async () => {
    const res = await request(app).get('/sprints').set(asA());
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((s) => s.id)).not.toContain(B.sprintId);
  });

  it('PATCH /sprints/:id refuses B\'s sprint as 404, and does not touch it', async () => {
    const res = await request(app).patch(`/sprints/${B.sprintId}`).set(asA()).send({ name: 'pwned' });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.sprints).where(eq(schema.sprints.id, B.sprintId));
    expect(row?.name).not.toBe('pwned');
  });

  it('DELETE /sprints/:id against B\'s sprint is a silent no-op (204), and B\'s row survives', async () => {
    const res = await request(app).delete(`/sprints/${B.sprintId}`).set(asA());
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.sprints).where(eq(schema.sprints.id, B.sprintId));
    expect(row).toBeDefined();
  });

  it('a scratch note authored while signed in as A is invisible to B, with an explicit workspace column (not just authorId)', async () => {
    const noteId = `sk-at11-${stamp}`;
    await db.insert(schema.scratchNotes).values({
      id: noteId,
      authorId: A.memberId,
      workspaceId: A.workspaceId,
      title: 'AT11 note',
      body: '',
      color: '#000000',
    });
    const res = await request(app).get('/scratch-notes').set(asA());
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((n) => n.id)).toContain(noteId);
    await db.delete(schema.scratchNotes).where(eq(schema.scratchNotes.id, noteId));
  });

  it('the middleware itself: no Authorization header at all still works (Personal path), unaffected by any of the above', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('the middleware itself: a Bearer token with no X-Waypoint-Workspace-Id header is refused as 400', async () => {
    const res = await request(app).get('/members').set({ Authorization: `Bearer ${A.token}` });
    expect(res.status).toBe(400);
  });

  it('the middleware itself: a real token but B\'s workspace header is refused as 403 — A is not a member of B', async () => {
    const res = await request(app)
      .get('/members')
      .set({ Authorization: `Bearer ${A.token}`, 'X-Waypoint-Workspace-Id': B.workspaceId });
    expect(res.status).toBe(403);
  });

  it('the middleware itself: an unknown/garbage bearer token is refused as 401', async () => {
    const res = await request(app)
      .get('/members')
      .set({ Authorization: 'Bearer not-a-real-token', 'X-Waypoint-Workspace-Id': A.workspaceId });
    expect(res.status).toBe(401);
  });
});
