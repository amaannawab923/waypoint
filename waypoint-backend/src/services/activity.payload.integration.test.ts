import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Ticket activity carries structured payloads (so the page can render
// "changed status Todo → In Progress" rather than a frozen sentence), logs
// the edits it used to miss, and gives one save one timestamp.
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

describe.skipIf(!REAL_DB)('ticket activity payloads against real Postgres', () => {
  let tickets: typeof import('./tickets.service.js');
  let comments: typeof import('./comments.service.js');
  let attachments: typeof import('./attachments.service.js');
  let activity: typeof import('./activity.service.js');
  let storageRoot = '';
  let db: (typeof import('../db/client.js'))['db'];
  let schema: typeof import('../db/schema/index.js');
  let d: typeof import('drizzle-orm');
  let runWithIdentity: (typeof import('../lib/requestContext.js'))['runWithIdentity'];

  const stamp = Date.now();
  const ws = `ws-itest-act-${stamp}`;
  const projectId = `proj-itest-act-${stamp}`;
  const ME = `mem-itest-act-me-${stamp}`;
  const OTHER = `mem-itest-act-other-${stamp}`;
  const todo = `st-act-todo-${stamp}`;
  const doing = `st-act-doing-${stamp}`;
  const sprintA = `sp-act-a-${stamp}`;
  const sprintB = `sp-act-b-${stamp}`;
  const label = `lbl-act-${stamp}`;
  const stream = `ws-act-stream-${stamp}`;
  let ticketId = '';

  const as = <T>(fn: () => Promise<T>) =>
    runWithIdentity({ userId: 'user-itest', memberId: ME, workspaceId: ws, role: 'admin' }, fn);
  const entries = () =>
    db
      .select()
      .from(schema.activityEntries)
      .where(d.eq(schema.activityEntries.ticketId, ticketId))
      .orderBy(d.asc(schema.activityEntries.createdAt));
  const only = async (verb: string) => (await entries()).filter((e) => e.verb === verb);

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    tickets = await import('./tickets.service.js');
    comments = await import('./comments.service.js');
    attachments = await import('./attachments.service.js');
    activity = await import('./activity.service.js');
    storageRoot = await mkdtemp(path.join(tmpdir(), 'waypoint-act-'));
    process.env.WAYPOINT_ATTACHMENTS_DIR = storageRoot;
    schema = await import('../db/schema/index.js');
    d = await import('drizzle-orm');
    ({ runWithIdentity } = await import('../lib/requestContext.js'));
    await db.insert(schema.workspaces).values({ id: ws, name: ws, slug: ws, companySize: '2-10', timezone: 'UTC' });
    await db.insert(schema.members).values(
      [ME, OTHER].map((id) => ({
        id,
        workspaceId: ws,
        fullName: `${id} Tester`,
        displayName: id === ME ? 'Me' : 'Other',
        email: `${id}@example.test`,
        avatarColor: '#000000',
      })),
    );
    await db.insert(schema.projects).values({
      id: projectId,
      workspaceId: ws,
      name: 'Activity project',
      identifier: `ACT${stamp % 1000}`,
      icon: 'folder',
      coverGradientStart: '#000000',
      coverGradientEnd: '#ffffff',
      timezone: 'UTC',
      automations: {},
    });
    await db.insert(schema.projectMembers).values([ME, OTHER].map((memberId) => ({ projectId, memberId })));
    await db.insert(schema.ticketStates).values([
      { id: todo, projectId, name: 'Todo', group: 'unstarted', color: '#111111', isDefault: true },
      { id: doing, projectId, name: 'Doing', group: 'started', color: '#222222', isDefault: false },
    ]);
    await db.insert(schema.labels).values({ id: label, projectId, name: 'bug', color: '#b7332a' });
    await db.insert(schema.sprints).values([
      { id: sprintA, projectId, name: 'Sprint A', startDate: '2026-10-01', endDate: '2026-10-14' },
      { id: sprintB, projectId, name: 'Sprint B', startDate: '2026-10-15', endDate: '2026-10-28' },
    ] as never);
    await db.insert(schema.workstreams).values({ id: stream, projectId, name: 'Onboarding' });
  });

  beforeEach(async () => {
    const t = await as(() =>
      tickets.createTicket({ projectId, title: 'Original title', stateId: todo, sprintId: sprintA }),
    );
    ticketId = t.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.projects).where(d.eq(schema.projects.id, projectId));
    await db.delete(schema.workspaces).where(d.eq(schema.workspaces.id, ws));
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it('records the status it moved from and to, with names and colours', async () => {
    await as(() => tickets.updateTicket(ticketId, { stateId: doing }));
    const [e] = await only('state_changed');
    expect(e!.payload).toMatchObject({
      fromState: { id: todo, name: 'Todo', group: 'unstarted', color: '#111111' },
      toState: { id: doing, name: 'Doing', group: 'started', color: '#222222' },
    });
  });

  it('logs title, description, estimate and sprint edits it used to miss, and one save shares one instant', async () => {
    await as(() =>
      tickets.updateTicket(ticketId, {
        title: 'Sharper title',
        description: 'Now with details',
        estimatePoints: 3,
        estimateValue: 'M',
        sprintId: sprintB,
        priority: 'high',
      }),
    );
    const all = await entries();
    const byVerb = Object.fromEntries(all.map((e) => [e.verb, e]));
    expect(byVerb.title_changed!.payload).toMatchObject({ from: 'Original title', to: 'Sharper title' });
    expect(byVerb.description_changed!.payload).toMatchObject({ to: 'set' });
    expect(byVerb.points_changed!.payload).toMatchObject({ from: null, to: 3 });
    expect(byVerb.estimate_changed!.payload).toMatchObject({ from: null, to: 'M' });
    expect(byVerb.sprint_changed!.payload).toMatchObject({ fromName: 'Sprint A', toName: 'Sprint B' });
    expect(byVerb.priority_changed!.payload).toMatchObject({ from: 'none', to: 'high' });
    const saveTimes = new Set(
      ['title_changed', 'description_changed', 'points_changed', 'estimate_changed', 'sprint_changed', 'priority_changed'].map((v) =>
        byVerb[v]!.createdAt.getTime(),
      ),
    );
    expect(saveTimes.size).toBe(1);
  });

  it('records clearing a date, not just setting one', async () => {
    await as(() => tickets.updateTicket(ticketId, { dueDate: '2026-10-09' }));
    await as(() => tickets.updateTicket(ticketId, { dueDate: null }));
    const rows = await only('due_date_set');
    expect(rows.map((r) => r.payload)).toEqual([
      { from: null, to: '2026-10-09' },
      { from: '2026-10-09', to: null },
    ]);
    expect(rows[1]!.detail).toBe('removed the due date');
  });

  it('names the people and labels it added or removed', async () => {
    await as(() => tickets.updateTicket(ticketId, { assigneeIds: [OTHER], labelIds: [label] }));
    expect((await only('assignee_added'))[0]!.payload).toMatchObject({ personId: OTHER, personName: 'Other' });
    expect((await only('label_added'))[0]!.payload).toMatchObject({ labelId: label, labelName: 'bug', labelColor: '#b7332a' });
  });

  it("marks a change applied from an agent's proposal", async () => {
    await as(() => tickets.updateTicket(ticketId, { stateId: doing }, { via: 'session' }));
    expect((await only('state_changed'))[0]!.payload).toMatchObject({ via: 'session' });
  });

  it('points a comment entry at its comment, and records the starting status on creation', async () => {
    const c = await as(() => comments.addComment(ticketId, 'looks good'));
    expect((await only('commented'))[0]!.payload).toMatchObject({ commentId: c.id });
    expect((await only('created'))[0]!.payload).toMatchObject({ toState: { id: todo, name: 'Todo' } });
  });

  it('writes nothing for a save that changes nothing', async () => {
    await as(() => tickets.updateTicket(ticketId, { estimatePoints: 2, estimateValue: 'S', description: 'Words' }));
    const before = (await entries()).length;
    await as(() =>
      tickets.updateTicket(ticketId, {
        title: 'Original title',
        description: 'Words  \n',
        estimatePoints: 2,
        estimateValue: 'S',
        sprintId: sprintA,
        stateId: todo,
        priority: 'none',
      }),
    );
    expect(await entries()).toHaveLength(before);
  });

  it('records workstream moves and start dates by name and value', async () => {
    await as(() => tickets.updateTicket(ticketId, { workstreamId: stream, startDate: '2026-10-02' }));
    await as(() => tickets.updateTicket(ticketId, { workstreamId: null }));
    expect((await only('workstream_changed')).map((e) => e.payload)).toEqual([
      { fromName: null, toName: 'Onboarding' },
      { fromName: 'Onboarding', toName: null },
    ]);
    expect((await only('start_date_set'))[0]!.payload).toEqual({ from: null, to: '2026-10-02' });
  });

  it('records the statuses a board drag moves between', async () => {
    const other = await as(() => tickets.createTicket({ projectId, title: 'Neighbour', stateId: doing }));
    await as(() => tickets.reorderTicket(ticketId, other.id, 'before'));
    expect((await only('state_changed'))[0]!.payload).toMatchObject({
      fromState: { id: todo, name: 'Todo' },
      toState: { id: doing, name: 'Doing' },
    });
  });

  it('records the link it added and removed', async () => {
    const withLink = await as(() => tickets.addTicketLink(ticketId, { url: 'https://example.test/spec', label: 'Spec' }));
    await as(() => tickets.removeTicketLink(ticketId, withLink.links[0]!.id));
    expect((await only('link_added'))[0]!.payload).toEqual({ url: 'https://example.test/spec', label: 'Spec' });
    expect((await only('link_removed'))[0]!.payload).toEqual({ url: 'https://example.test/spec', label: 'Spec' });
  });

  it('records the file a comment attached and its removal', async () => {
    const file = await as(() =>
      attachments.uploadAttachment(ticketId, { filename: 'trace.log', mimeType: 'text/plain', bytes: Buffer.from('x') }),
    );
    await as(() => comments.addComment(ticketId, 'see attached', 'left a comment', null, [file.id]));
    await as(() => attachments.deleteAttachment(file.id));
    expect((await only('attachment_added'))[0]!.payload).toEqual({ attachmentId: file.id, filename: 'trace.log' });
    expect((await only('attachment_removed'))[0]!.payload).toEqual({ attachmentId: file.id, filename: 'trace.log' });
  });

  it('lists one save in a stable order', async () => {
    await as(() => tickets.updateTicket(ticketId, { title: 'A', priority: 'low', estimatePoints: 1 }));
    const first = await as(() => activity.listActivity(ticketId));
    const again = await as(() => activity.listActivity(ticketId));
    expect(again.map((e) => e.id)).toEqual(first.map((e) => e.id));
    const sameInstant = first.filter((e) => e.createdAt.getTime() === first[first.length - 1]!.createdAt.getTime());
    expect(sameInstant.map((e) => e.id)).toEqual([...sameInstant.map((e) => e.id)].sort());
  });
});
