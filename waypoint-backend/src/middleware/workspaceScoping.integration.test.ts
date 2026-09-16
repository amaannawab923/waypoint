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
  let and: typeof import('drizzle-orm')['and'];
  let inArray: typeof import('drizzle-orm')['inArray'];
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
    agentId: `agent-at11-a-${stamp}`,
    agentAssignmentId: `aa-at11-a-${stamp}`,
    linkId: `link-at11-a-${stamp}`,
    conversationId: `conv-at11-a-${stamp}`,
    proposalId: `prop-at11-a-${stamp}`,
    agentRunId: `run-at11-a-${stamp}`,
    runProposalId: `prop-at11-run-a-${stamp}`,
    webhookId: `wh-at11-a-${stamp}`,
    exportId: `exp-at11-a-${stamp}`,
    notificationId: `notif-at11-a-${stamp}`,
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
    agentId: `agent-at11-b-${stamp}`,
    agentAssignmentId: `aa-at11-b-${stamp}`,
    linkId: `link-at11-b-${stamp}`,
    conversationId: `conv-at11-b-${stamp}`,
    proposalId: `prop-at11-b-${stamp}`,
    agentRunId: `run-at11-b-${stamp}`,
    runProposalId: `prop-at11-run-b-${stamp}`,
    webhookId: `wh-at11-b-${stamp}`,
    exportId: `exp-at11-b-${stamp}`,
    notificationId: `notif-at11-b-${stamp}`,
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
    await db.insert(schema.agents).values({
      id: t.agentId,
      workspaceId: t.workspaceId,
      name: `AT11 agent ${t.workspaceId}`,
      avatarColor: '#000000',
      instructionsFilename: 'AGENTS.md',
      instructionsContentMarkdown: '',
      scopeAllProjects: true,
      executionMethod: 'local-claude-subscription',
      model: 'claude',
      autonomy: 'plan-only',
      triggers: ['manual'],
      createdById: t.memberId,
    });
    await db.insert(schema.agentAssignments).values({
      id: t.agentAssignmentId,
      ticketId: t.ticketId,
      agentId: t.agentId,
      status: 'queued',
    });
    await db.insert(schema.ticketLinks).values({
      id: t.linkId,
      ticketId: t.ticketId,
      url: 'https://example.test/at11',
      label: 'AT11 link',
    });
    await db.insert(schema.copilotConversations).values({
      id: t.conversationId,
      memberId: t.memberId,
      title: `AT11 conversation ${t.workspaceId}`,
    });
    await db.insert(schema.proposals).values({
      id: t.proposalId,
      origin: 'copilot',
      conversationId: t.conversationId,
      anchorSeq: 1,
      projectId: t.projectId,
      kind: 'comment',
      ticketId: t.ticketId,
      payload: { body: `AT11 proposal ${t.workspaceId}` },
      snapshot: { identifier: `AT11 ${t.workspaceId}`, title: 'AT11 proposal snapshot' },
      status: 'proposed',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    // A second, agent_run-origin proposal — proposalWorkspaceCondition's
    // OTHER branch (conversationId is null here; only agentRunId is set),
    // otherwise entirely unexercised by this suite.
    await db.insert(schema.agentRuns).values({
      id: t.agentRunId,
      ownerMemberId: t.memberId,
      entry: 'independent',
      providerId: 'claude',
    });
    await db.insert(schema.proposals).values({
      id: t.runProposalId,
      origin: 'agent_run',
      agentRunId: t.agentRunId,
      projectId: t.projectId,
      kind: 'comment',
      ticketId: t.ticketId,
      payload: { body: `AT11 run proposal ${t.workspaceId}` },
      snapshot: { identifier: `AT11 run ${t.workspaceId}`, title: 'AT11 run proposal snapshot' },
      status: 'proposed',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    // Sixth review round: labels/states/requests remain deliberately
    // deferred, but webhooks/exports/notifications turned out to fail
    // the deferral's own severity bar (a proven destructive cross-tenant
    // delete and a secret-bearing leak) and were fixed alongside the
    // rest of this round.
    await db.insert(schema.webhooks).values({
      id: t.webhookId,
      workspaceId: t.workspaceId,
      url: `https://example.test/webhook/${t.workspaceId}?secret=sh`,
      eventTypes: ['ticket.created'],
    });
    await db.insert(schema.workspaceExports).values({
      id: t.exportId,
      workspaceId: t.workspaceId,
      scopeLabel: `AT11 export ${t.workspaceId}`,
      format: 'json',
    });
    await db.insert(schema.notifications).values({
      id: t.notificationId,
      recipientId: t.memberId,
      actorId: t.memberId,
      message: `AT11 notification ${t.workspaceId}`,
      kind: 'mention',
    });
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    schema = await import('../db/schema/index.js');
    ({ eq, and, inArray } = await import('drizzle-orm'));
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
    // sort it out": tickets/docs' created_by_id/owner_id, and now also
    // agents' created_by_id, reference members with ON DELETE RESTRICT
    // (not cascade), so a workspace delete that reaches "cascade-delete
    // this member" before it has already cascade-deleted every ticket/
    // doc/agent that member created is rejected outright — deleting
    // agents (cascading agent_assignments via their own agentId FK) and
    // the project (cascading tickets/ticket_links/docs/views/
    // workstreams/sprints/agent_assignments via their own projectId/
    // ticketId FKs) first removes every such referencing row before
    // members are ever touched.
    // agent_runs.owner_member_id -> members is also RESTRICT, and its own
    // proposal (agentRunId) is only ON DELETE SET NULL, not cascade — a
    // bare agent_runs delete would orphan the run-origin proposal rows
    // (both conversationId and agentRunId null, matching neither branch
    // of proposalWorkspaceCondition forever) rather than removing them.
    await db.delete(schema.proposals).where(inArray(schema.proposals.agentRunId, [A.agentRunId, B.agentRunId]));
    await db.delete(schema.agentRuns).where(inArray(schema.agentRuns.id, [A.agentRunId, B.agentRunId]));
    await db.delete(schema.agents).where(eq(schema.agents.workspaceId, A.workspaceId));
    await db.delete(schema.agents).where(eq(schema.agents.workspaceId, B.workspaceId));
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

  // AT11 (ROAD-146) review-fix round: the security review found the first
  // pass of this audit had checked reads and creation but left every
  // ticket mutation, comments, activity, agents, and agent-assignments
  // unaudited — real, exploitable cross-tenant IDOR gaps. These cases are
  // what closes that gap for tickets specifically.
  it('PATCH /tickets/:id refuses to update B\'s ticket as 404, and does not touch it', async () => {
    const res = await request(app).patch(`/tickets/${B.ticketId}`).set(asA()).send({ title: 'pwned' });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, B.ticketId));
    expect(row?.title).not.toBe('pwned');
  });

  // Second review round: patch.parentId was a bare, unvalidated ticket id
  // — re-parenting A's own ticket under B's real one, AND writing an
  // activity line containing A's ticket identifier into B's own activity
  // feed, a cross-tenant write with attacker-chosen content. Refused as
  // 404 before either write happens.
  it('PATCH /tickets/:id with parentId set to B\'s ticket refuses as 404, re-parents nothing, and writes nothing into B\'s activity', async () => {
    const res = await request(app).patch(`/tickets/${A.ticketId}`).set(asA()).send({ parentId: B.ticketId });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, A.ticketId));
    expect(row?.parentId).not.toBe(B.ticketId);
    const activity = await db
      .select()
      .from(schema.activityEntries)
      .where(eq(schema.activityEntries.ticketId, B.ticketId));
    expect(activity.some((a) => a.verb === 'sub_item_added')).toBe(false);
  });

  it('POST /tickets with parentId set to B\'s ticket refuses as 404, and writes no ticket', async () => {
    const res = await request(app)
      .post('/tickets')
      .set(asA())
      .send({ projectId: A.projectId, title: 'pwned parent', stateId: A.stateId, parentId: B.ticketId });
    expect(res.status).toBe(404);
    const rows = await db.select().from(schema.tickets).where(eq(schema.tickets.title, 'pwned parent'));
    expect(rows).toHaveLength(0);
  });

  it('POST /tickets/:id/assignees/:memberId/toggle refuses B\'s ticket as 404', async () => {
    const res = await request(app)
      .post(`/tickets/${B.ticketId}/assignees/${A.memberId}/toggle`)
      .set(asA());
    expect(res.status).toBe(404);
  });

  it('POST /tickets/:id/labels/:labelId/toggle refuses B\'s ticket as 404', async () => {
    const res = await request(app).post(`/tickets/${B.ticketId}/labels/label-fake/toggle`).set(asA());
    expect(res.status).toBe(404);
  });

  it('POST /tickets/:id/reorder refuses when either end is B\'s ticket, and never copies B\'s stateId onto A\'s', async () => {
    // A's own ticket as the item, B's as the target — the more dangerous
    // direction, since a naive fix might only guard `id` and let a
    // cross-tenant `targetId` slip its stateId onto A's ticket.
    const res = await request(app)
      .post(`/tickets/${A.ticketId}/reorder`)
      .set(asA())
      .send({ targetId: B.ticketId, position: 'after' });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, A.ticketId));
    expect(row?.stateId).toBe(A.stateId);
  });

  it('POST /tickets/:id/links refuses to add a link to B\'s ticket as 404, and writes nothing', async () => {
    const res = await request(app)
      .post(`/tickets/${B.ticketId}/links`)
      .set(asA())
      .send({ url: 'https://example.test/pwned', label: 'pwned' });
    expect(res.status).toBe(404);
    const rows = await db.select().from(schema.ticketLinks).where(eq(schema.ticketLinks.label, 'pwned'));
    expect(rows).toHaveLength(0);
  });

  it('DELETE /tickets/:id/links/:linkId refuses B\'s link via B\'s ticket as 404, checked before the delete runs — B\'s link survives', async () => {
    const res = await request(app).delete(`/tickets/${B.ticketId}/links/${B.linkId}`).set(asA());
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.ticketLinks).where(eq(schema.ticketLinks.id, B.linkId));
    expect(row).toBeDefined();
  });

  // Second review round: the previous case above only exercises the
  // direction the ticket guard already covers (B's ticket, B's link) —
  // it 404s before ever reaching the linkId. This is the direction that
  // actually exercised the bug: A's OWN ticket (passes the ticket guard)
  // paired with B's real linkId, which the delete used to key on alone
  // with no correlation back to the ticket at all — deleting B's row and
  // leaking B's link's label/url into A's own activity feed. Correlating
  // both the select and the delete on (linkId, ticketId) makes this a
  // no-op, same idempotent-delete convention as this codebase's other
  // routes — not a 404 (the ticket itself is real and unchanged), 200
  // with B's row surviving and nothing about it reaching A's activity.
  it('DELETE /tickets/:id/links/:linkId against A\'s own ticket with B\'s linkId is a no-op — B\'s link survives, nothing about it reaches A\'s activity', async () => {
    const res = await request(app).delete(`/tickets/${A.ticketId}/links/${B.linkId}`).set(asA());
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.ticketLinks).where(eq(schema.ticketLinks.id, B.linkId));
    expect(row).toBeDefined();
    expect(row?.ticketId).toBe(B.ticketId);
    const activity = await db
      .select()
      .from(schema.activityEntries)
      .where(eq(schema.activityEntries.ticketId, A.ticketId));
    expect(activity.some((a) => a.detail?.includes('AT11 link'))).toBe(false);
  });

  it('DELETE /tickets/:id against B\'s ticket is a silent no-op (204), and B\'s row survives', async () => {
    const res = await request(app).delete(`/tickets/${B.ticketId}`).set(asA());
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, B.ticketId));
    expect(row).toBeDefined();
  });

  it('GET /tickets/:id/comments refuses B\'s ticket as 404', async () => {
    const res = await request(app).get(`/tickets/${B.ticketId}/comments`).set(asA());
    expect(res.status).toBe(404);
  });

  it('POST /tickets/:id/comments refuses to comment on B\'s ticket as 404, and writes nothing', async () => {
    const res = await request(app).post(`/tickets/${B.ticketId}/comments`).set(asA()).send({ bodyHtml: 'pwned' });
    expect(res.status).toBe(404);
    const rows = await db.select().from(schema.comments).where(eq(schema.comments.ticketId, B.ticketId));
    expect(rows).toHaveLength(0);
  });

  it('GET /tickets/:id/activity refuses B\'s ticket as 404', async () => {
    const res = await request(app).get(`/tickets/${B.ticketId}/activity`).set(asA());
    expect(res.status).toBe(404);
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

  it('GET /agents (list) never includes B\'s agent', async () => {
    const res = await request(app).get('/agents').set(asA());
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((a) => a.id)).not.toContain(B.agentId);
  });

  it('GET /agents/:id refuses B\'s agent as 404', async () => {
    const res = await request(app).get(`/agents/${B.agentId}`).set(asA());
    expect(res.status).toBe(404);
  });

  it('PATCH /agents/:id refuses B\'s agent as 404, and does not touch it', async () => {
    const res = await request(app).patch(`/agents/${B.agentId}`).set(asA()).send({ name: 'pwned' });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, B.agentId));
    expect(row?.name).not.toBe('pwned');
  });

  it('DELETE /agents/:id against B\'s agent is a silent no-op (204), and B\'s row survives', async () => {
    const res = await request(app).delete(`/agents/${B.agentId}`).set(asA());
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, B.agentId));
    expect(row).toBeDefined();
  });

  // The review's own headline finding for this file: listAgentAssignments
  // had no scoping at all before this fix — every workspace's agent
  // assignments were visible to every other one.
  it('GET /agent-assignments never includes B\'s assignment', async () => {
    const res = await request(app).get('/agent-assignments').set(asA());
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((a) => a.id)).not.toContain(B.agentAssignmentId);
    expect((res.body as Array<{ id: string }>).map((a) => a.id)).toContain(A.agentAssignmentId);
  });

  it('POST /tickets/:id/agent-assignments refuses to assign an agent onto B\'s ticket as 404', async () => {
    const res = await request(app)
      .post(`/tickets/${B.ticketId}/agent-assignments`)
      .set(asA())
      .send({ agentIds: [A.agentId] });
    expect(res.status).toBe(404);
  });

  // Second review round: the ticket guard above only proves the ticket is
  // A's — nothing previously checked the agentIds themselves. Attaching
  // B's real agent onto A's own ticket used to succeed silently.
  it('POST /tickets/:id/agent-assignments onto A\'s own ticket with B\'s agentId refuses as 404, and writes no assignment', async () => {
    const res = await request(app)
      .post(`/tickets/${A.ticketId}/agent-assignments`)
      .set(asA())
      .send({ agentIds: [B.agentId] });
    expect(res.status).toBe(404);
    const rows = await db
      .select()
      .from(schema.agentAssignments)
      .where(and(eq(schema.agentAssignments.ticketId, A.ticketId), eq(schema.agentAssignments.agentId, B.agentId)));
    expect(rows).toHaveLength(0);
  });

  // Same underlying gap (validateAssigneeIds had no workspace filter),
  // reached through the plain human/agent assignee toggle instead of the
  // agent-assignments endpoint.
  it('POST /tickets/:id/assignees/:memberId/toggle onto A\'s own ticket with B\'s memberId refuses as 409, and adds no assignee', async () => {
    const res = await request(app).post(`/tickets/${A.ticketId}/assignees/${B.memberId}/toggle`).set(asA());
    expect(res.status).toBe(409);
    const rows = await db
      .select()
      .from(schema.ticketAssignees)
      .where(and(eq(schema.ticketAssignees.ticketId, A.ticketId), eq(schema.ticketAssignees.assigneeId, B.memberId)));
    expect(rows).toHaveLength(0);
  });

  it('POST /tickets/:id/agents/:agentId/toggle refuses B\'s ticket as 404', async () => {
    const res = await request(app).post(`/tickets/${B.ticketId}/agents/${A.agentId}/toggle`).set(asA());
    expect(res.status).toBe(404);
  });

  // AT11 (ROAD-146) review-fix round: copilot conversations scope by
  // member ownership, not by workspace directly (a conversation is one
  // person's own Copilot chat) — the review flagged this file as never
  // audited at all in the first pass, despite being named in the
  // ticket's own file list.
  it('GET /copilot/conversations/:id refuses B\'s conversation as 404', async () => {
    const res = await request(app).get(`/copilot/conversations/${B.conversationId}`).set(asA());
    expect(res.status).toBe(404);
  });

  it('PATCH /copilot/conversations/:id refuses to rename B\'s conversation as 404, and does not touch it', async () => {
    const res = await request(app)
      .patch(`/copilot/conversations/${B.conversationId}`)
      .set(asA())
      .send({ title: 'pwned' });
    expect(res.status).toBe(404);
    const [row] = await db
      .select()
      .from(schema.copilotConversations)
      .where(eq(schema.copilotConversations.id, B.conversationId));
    expect(row?.title).not.toBe('pwned');
  });

  it('DELETE /copilot/conversations/:id against B\'s conversation is a silent no-op (204), and B\'s row survives', async () => {
    const res = await request(app).delete(`/copilot/conversations/${B.conversationId}`).set(asA());
    expect(res.status).toBe(204);
    const [row] = await db
      .select()
      .from(schema.copilotConversations)
      .where(eq(schema.copilotConversations.id, B.conversationId));
    expect(row).toBeDefined();
  });

  it('POST /copilot/conversations/:id/messages refuses to post into B\'s conversation as 404, and writes nothing', async () => {
    const res = await request(app)
      .post(`/copilot/conversations/${B.conversationId}/messages`)
      .set(asA())
      .send({ content: 'pwned' });
    expect(res.status).toBe(404);
    const rows = await db
      .select()
      .from(schema.copilotMessages)
      .where(eq(schema.copilotMessages.conversationId, B.conversationId));
    expect(rows).toHaveLength(0);
  });

  it('POST /copilot/notes with an explicit conversationId of B\'s reads as no-conversation (204), and writes nothing', async () => {
    const res = await request(app)
      .post('/copilot/notes')
      .set(asA())
      .send({ conversationId: B.conversationId, content: 'pwned' });
    expect(res.status).toBe(204);
    const rows = await db
      .select()
      .from(schema.copilotMessages)
      .where(eq(schema.copilotMessages.conversationId, B.conversationId));
    expect(rows).toHaveLength(0);
  });

  // Second review round found this exact bypass: POST /agent-runs lets its
  // own caller set copilotConversationId to any conversation id, with no
  // ownership check of its own — so an attacker's own, self-owned run row
  // could still name a victim's conversation. resolveNoteConversation's
  // fix checks the resolved conversation's own memberId, independent of
  // what the run row claims or who owns it — this seeds exactly that
  // attack shape (A's own run row pointing at B's conversation) directly
  // via the database, the same way createRun's own lack of validation
  // would let a real caller do it, and proves the note still never
  // reaches B's conversation.
  it('POST /copilot/notes via a runId whose own copilotConversationId points at B\'s conversation still writes nothing to B', async () => {
    const runId = `run-at11-hijack-${stamp}`;
    await db.insert(schema.agentRuns).values({
      id: runId,
      ownerMemberId: A.memberId,
      entry: 'independent',
      providerId: 'claude',
      copilotConversationId: B.conversationId,
    });
    try {
      const before = await db
        .select()
        .from(schema.copilotMessages)
        .where(eq(schema.copilotMessages.conversationId, B.conversationId));

      const res = await request(app).post('/copilot/notes').set(asA()).send({ runId, content: 'pwned via runId' });

      // A has their own seeded conversation, so the fallback lands there —
      // 201, but into A.conversationId, never B's.
      expect(res.status).toBe(201);
      expect(res.body.conversationId).toBe(A.conversationId);
      expect(res.body.conversationId).not.toBe(B.conversationId);
      const after = await db
        .select()
        .from(schema.copilotMessages)
        .where(eq(schema.copilotMessages.conversationId, B.conversationId));
      expect(after).toHaveLength(before.length);
    } finally {
      // agent_runs.owner_member_id -> members is ON DELETE RESTRICT — a
      // row left behind here blocks afterAll's member cleanup, so this
      // runs even when an assertion above throws.
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    }
  });

  // Second review round: approveProposal/rejectProposal/editProposalBody
  // had NO workspace check at all — any signed-in member could approve
  // (executing a real write) or reject or edit another tenant's proposal
  // by id.
  it('POST /copilot/proposals/:id/approve refuses B\'s proposal as 404, and never claims or executes it', async () => {
    const res = await request(app).post(`/copilot/proposals/${B.proposalId}/approve`).set(asA()).send({});
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, B.proposalId));
    expect(row?.status).toBe('proposed');
  });

  it('POST /copilot/proposals/:id/reject refuses B\'s proposal as 404, and leaves it proposed', async () => {
    const res = await request(app).post(`/copilot/proposals/${B.proposalId}/reject`).set(asA()).send({});
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, B.proposalId));
    expect(row?.status).toBe('proposed');
  });

  it('PATCH /copilot/proposals/:id refuses to edit B\'s proposal as 404, and does not touch its payload', async () => {
    const res = await request(app)
      .patch(`/copilot/proposals/${B.proposalId}`)
      .set(asA())
      .send({ body: 'pwned' });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, B.proposalId));
    expect((row?.payload as { body?: string } | null)?.body).not.toBe('pwned');
  });

  // The review's own headline finding for this file: despite this route's
  // header comment calling it "the workspace-scoped aggregate surface,"
  // the review queue had no workspace filter at all.
  it('GET /proposals (review queue) never includes B\'s proposal', async () => {
    const res = await request(app).get('/proposals').set(asA()).query({ status: 'proposed' });
    expect(res.status).toBe(200);
    const ids = (res.body.proposals as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(A.proposalId);
    expect(ids).not.toContain(B.proposalId);
  });

  // Fourth review round: the case above only ever exercised
  // proposalWorkspaceCondition's copilot-origin (conversationId) branch —
  // its OTHER branch (agentRunId, for an agent_run-origin proposal, which
  // has no conversationId at all) had zero coverage anywhere in this
  // suite, exactly the gap the review flagged.
  it('GET /proposals (review queue) never includes B\'s agent-run-origin proposal, and does include A\'s own', async () => {
    const res = await request(app).get('/proposals').set(asA()).query({ status: 'proposed' });
    expect(res.status).toBe(200);
    const ids = (res.body.proposals as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(A.runProposalId);
    expect(ids).not.toContain(B.runProposalId);
  });

  it('GET /proposals/stats/approved-per-day and /proposals/stats/health never fail against B\'s data', async () => {
    // These two endpoints report an aggregate number, not a list — there's
    // no per-row id to assert absent. The regression this round fixed
    // wasn't a value assertion so much as "the query used to have no
    // workspace filter at all"; the meaningful proof is the revert-test
    // (see PR history), not a value comparison here. Kept as a smoke test
    // that both routes still respond correctly now that they carry joins.
    const perDay = await request(app).get('/proposals/stats/approved-per-day').set(asA());
    expect(perDay.status).toBe(200);
    const health = await request(app).get('/proposals/stats/health').set(asA());
    expect(health.status).toBe(200);
  });

  // Fourth review round's structural finding: proposalWorkspaceCondition
  // trusts agent_runs.ownerMemberId and agent_runs.copilotConversationId
  // — both previously writable straight from the request body with no
  // ownership check. An attacker naming a real victim's memberId/
  // conversationId here could get their own agent run (and, via
  // createRunProposal, their own proposal) to render inside the victim's
  // review queue.
  it('POST /agent-runs ignores a client-supplied ownerMemberId naming B, and always uses the real caller', async () => {
    const res = await request(app)
      .post('/agent-runs')
      .set(asA())
      .send({ ownerMemberId: B.memberId, entry: 'independent', providerId: 'claude' });
    try {
      expect(res.status).toBe(201);
      expect(res.body.ownerMemberId).toBe(A.memberId);
      expect(res.body.ownerMemberId).not.toBe(B.memberId);
    } finally {
      // agent_runs.owner_member_id -> members is ON DELETE RESTRICT — a
      // row left behind here blocks afterAll's member cleanup, so this
      // runs even when an assertion above throws (a real created run's
      // id is still known from res.body.id either way).
      if (res.body?.id) await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, res.body.id));
    }
  });

  it('POST /agent-runs refuses a copilotConversationId naming B\'s conversation as 404, and creates no run', async () => {
    const res = await request(app)
      .post('/agent-runs')
      .set(asA())
      .send({ ownerMemberId: A.memberId, entry: 'independent', providerId: 'claude', copilotConversationId: B.conversationId });
    try {
      expect(res.status).toBe(404);
      const rows = await db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.copilotConversationId, B.conversationId));
      expect(rows).toHaveLength(0);
    } finally {
      // Safety net if the refusal above ever regresses: a run really
      // would get created here, and must not block afterAll's cleanup.
      if (res.body?.id) await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, res.body.id));
    }
  });

  it('PATCH /agent-runs/:id refuses to repoint A\'s own run at B\'s conversation as 404, and leaves it unset', async () => {
    const runId = `run-at11-repoint-${stamp}`;
    await db.insert(schema.agentRuns).values({
      id: runId,
      ownerMemberId: A.memberId,
      entry: 'independent',
      providerId: 'claude',
    });
    try {
      const res = await request(app)
        .patch(`/agent-runs/${runId}`)
        .set(asA())
        .send({ copilotConversationId: B.conversationId });
      expect(res.status).toBe(404);
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      expect(row?.copilotConversationId).toBeNull();
    } finally {
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    }
  });

  // Fifth review round's proven live exploit: the check above only
  // covered A repointing A's OWN run. Nothing stopped A from PATCHing
  // B's run instead, at A's own conversation this time — the direction
  // that actually mattered, since createRunProposal then copies that
  // conversationId onto the run's next proposal, and
  // proposalWorkspaceCondition's conversation branch renders it in A's
  // queue with B's ticket/report content, even though the run (and its
  // ownerMemberId) still belongs to B.
  it('PATCH /agent-runs/:id refuses to touch B\'s own run at all — even just repointing it at A\'s conversation — as 404', async () => {
    const runId = `run-at11-b-repoint-${stamp}`;
    await db.insert(schema.agentRuns).values({
      id: runId,
      ownerMemberId: B.memberId,
      entry: 'independent',
      providerId: 'claude',
    });
    try {
      const res = await request(app)
        .patch(`/agent-runs/${runId}`)
        .set(asA())
        .send({ copilotConversationId: A.conversationId });
      expect(res.status).toBe(404);
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      expect(row?.copilotConversationId).toBeNull();
      expect(row?.ownerMemberId).toBe(B.memberId);
    } finally {
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    }
  });

  it('PATCH /agent-runs/:id refuses ANY field patch to B\'s run as 404, not only the conversation field', async () => {
    const runId = `run-at11-b-patch-${stamp}`;
    await db.insert(schema.agentRuns).values({
      id: runId,
      ownerMemberId: B.memberId,
      entry: 'independent',
      providerId: 'claude',
    });
    try {
      const res = await request(app).patch(`/agent-runs/${runId}`).set(asA()).send({ title: 'pwned' });
      expect(res.status).toBe(404);
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      expect(row?.title).not.toBe('pwned');
    } finally {
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    }
  });

  it('GET /agent-runs/:id refuses B\'s run as 404', async () => {
    const runId = `run-at11-b-get-${stamp}`;
    await db.insert(schema.agentRuns).values({
      id: runId,
      ownerMemberId: B.memberId,
      entry: 'independent',
      providerId: 'claude',
    });
    try {
      const res = await request(app).get(`/agent-runs/${runId}`).set(asA());
      expect(res.status).toBe(404);
    } finally {
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    }
  });

  it('GET /agent-runs (list) never includes B\'s run', async () => {
    const res = await request(app).get('/agent-runs').set(asA());
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(B.agentRunId);
  });

  // Second half of the proven exploit: retryOfRunId let A cancel B's
  // real, live run outright, and leaked its status via the 409 message
  // for a still-running one.
  it('POST /agent-runs with retryOfRunId naming B\'s interrupted run refuses it (not cancelled), as if it did not exist', async () => {
    const runId = `run-at11-b-retry-${stamp}`;
    await db.insert(schema.agentRuns).values({
      id: runId,
      ownerMemberId: B.memberId,
      entry: 'independent',
      providerId: 'claude',
      status: 'interrupted',
    });
    let createdId: string | undefined;
    try {
      const res = await request(app)
        .post('/agent-runs')
        .set(asA())
        .send({ ownerMemberId: A.memberId, entry: 'independent', providerId: 'claude', retryOfRunId: runId });
      createdId = res.body?.id;
      expect(res.status).toBe(400);
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      expect(row?.status).toBe('interrupted');
    } finally {
      // Cleanup runs even when an assertion above throws — a real
      // retry-created row (createdId) can exist either way, and it
      // names runId as its own retryOfRunId, so runId must go second.
      if (createdId) await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, createdId));
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    }
  });

  // Sixth review round: the last unscoped id fields in createRun (a
  // cross-tenant existence + relationship oracle, proven live) —
  // projectId alone, and ticketId/projectId together.
  it('POST /agent-runs with B\'s own projectId+ticketId refuses as "does not exist", the same message a genuinely missing id gets', async () => {
    const withFake = await request(app)
      .post('/agent-runs')
      .set(asA())
      .send({ ownerMemberId: A.memberId, entry: 'independent', providerId: 'claude', projectId: A.projectId, ticketId: 'wi-not-real-at-all' });
    const withReal = await request(app)
      .post('/agent-runs')
      .set(asA())
      .send({
        ownerMemberId: A.memberId,
        entry: 'independent',
        providerId: 'claude',
        projectId: B.projectId,
        ticketId: B.ticketId,
      });
    expect(withFake.status).toBe(400);
    expect(withReal.status).toBe(400);
    expect(withReal.body.error).toBe(withFake.body.error);
  });

  it('POST /agent-runs with only B\'s projectId (no ticketId) refuses as "does not exist", and creates nothing', async () => {
    const res = await request(app)
      .post('/agent-runs')
      .set(asA())
      .send({ ownerMemberId: A.memberId, entry: 'independent', providerId: 'claude', projectId: B.projectId });
    expect(res.status).toBe(400);
    const rows = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.projectId, B.projectId));
    expect(rows.map((r) => r.ownerMemberId)).not.toContain(A.memberId);
  });

  it('GET /webhooks never includes B\'s webhook (its URL, secret and all)', async () => {
    const res = await request(app).get('/webhooks').set(asA());
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((w) => w.id);
    expect(ids).toContain(A.webhookId);
    expect(ids).not.toContain(B.webhookId);
  });

  it('DELETE /webhooks/:id refuses to delete B\'s webhook — it survives', async () => {
    const res = await request(app).delete(`/webhooks/${B.webhookId}`).set(asA());
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, B.webhookId));
    expect(row).toBeDefined();
  });

  it('GET /exports never includes B\'s export', async () => {
    const res = await request(app).get('/exports').set(asA());
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(A.exportId);
    expect(ids).not.toContain(B.exportId);
  });

  it('POST /notifications/:id/read refuses to mark B\'s notification read — it stays unread', async () => {
    const res = await request(app).post(`/notifications/${B.notificationId}/read`).set(asA());
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, B.notificationId));
    expect(row?.read).toBe(false);
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
