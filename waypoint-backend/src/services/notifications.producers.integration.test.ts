import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';

// Replies, comments on followed tickets, and assignments, against real
// Postgres: who gets what, strongest reason first, grouping into one open
// row per ticket, withdrawal on unassign, and resolve-on-open.
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

describe.skipIf(!REAL_DB)('notification producers against real Postgres', () => {
  let comments: typeof import('./comments.service.js');
  let ticketsSvc: typeof import('./tickets.service.js');
  let notif: typeof import('./notifications.service.js');
  let db: (typeof import('../db/client.js'))['db'];
  let schema: typeof import('../db/schema/index.js');
  let d: typeof import('drizzle-orm');
  let runWithIdentity: (typeof import('../lib/requestContext.js'))['runWithIdentity'];

  const stamp = Date.now();
  const ws = `ws-itest-prod-${stamp}`;
  const otherWs = `ws-itest-prod-other-${stamp}`;
  const projectId = `proj-itest-prod-${stamp}`;
  const stateId = `st-itest-prod-${stamp}`;
  const ticketId = `tk-itest-prod-${stamp}`;
  const key = `RPR${stamp % 1000}-1`;

  const CREATOR = `mem-prod-creator-${stamp}`;
  const ASSIGNEE = `mem-prod-assignee-${stamp}`;
  const TALKER = `mem-prod-talker-${stamp}`; // commented before
  const ACTOR = `mem-prod-actor-${stamp}`;
  const SECOND = `mem-prod-second-${stamp}`;
  const MUTED = `mem-prod-muted-${stamp}`; // comments + mentions off
  const BYSTANDER = `mem-prod-bystander-${stamp}`; // no role on the ticket
  const OUTSIDER = `mem-prod-outsider-${stamp}`; // another workspace

  const as = <T>(memberId: string, fn: () => Promise<T>) =>
    runWithIdentity({ userId: 'user-itest', memberId, workspaceId: ws, role: 'admin' }, fn);

  async function rowsFor(recipientId: string) {
    return db
      .select()
      .from(schema.notifications)
      .where(d.and(d.eq(schema.notifications.recipientId, recipientId), d.eq(schema.notifications.ticketId, ticketId)))
      .orderBy(d.asc(schema.notifications.createdAt));
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    comments = await import('./comments.service.js');
    ticketsSvc = await import('./tickets.service.js');
    notif = await import('./notifications.service.js');
    schema = await import('../db/schema/index.js');
    d = await import('drizzle-orm');
    ({ runWithIdentity } = await import('../lib/requestContext.js'));

    for (const id of [ws, otherWs]) {
      await db.insert(schema.workspaces).values({ id, name: id, slug: id, companySize: '2-10', timezone: 'UTC' });
    }
    const member = (id: string, name: string, w = ws, notificationPrefs: unknown = null) => ({
      id,
      workspaceId: w,
      fullName: `${name} Tester`,
      displayName: `${name}${stamp}`,
      email: `${id}@example.test`,
      avatarColor: '#000000',
      notificationPrefs,
    });
    await db.insert(schema.members).values([
      member(CREATOR, 'Creator'),
      member(ASSIGNEE, 'Assignee'),
      member(TALKER, 'Talker'),
      member(ACTOR, 'Actor'),
      member(SECOND, 'Second'),
      member(MUTED, 'Muted', ws, { comments: false, mentions: false }),
      member(BYSTANDER, 'Bystander'),
      member(OUTSIDER, 'Outsider', otherWs),
    ]);
    await db.insert(schema.projects).values({
      id: projectId,
      workspaceId: ws,
      name: 'Producers project',
      identifier: `RPR${stamp % 1000}`,
      icon: 'folder',
      coverGradientStart: '#000000',
      coverGradientEnd: '#ffffff',
      timezone: 'UTC',
      automations: {},
      // The ticket below is inserted directly as #1, so createTicket's own
      // counter has to start past it.
      nextSequenceId: 1,
    });
    await db.insert(schema.ticketStates).values({
      id: stateId,
      projectId,
      name: 'Todo',
      group: 'unstarted',
      color: '#000000',
      isDefault: true,
    });
    await db.insert(schema.tickets).values({
      id: ticketId,
      projectId,
      identifier: key,
      sequenceId: 1,
      title: 'Search indexer misses the last page',
      stateId,
      createdById: CREATOR,
    });
    await db.insert(schema.ticketAssignees).values([
      { ticketId, assigneeId: ASSIGNEE, assigneeKind: 'member' },
      { ticketId, assigneeId: MUTED, assigneeKind: 'member' },
    ]);
    // Talker has commented before, which makes them a follower.
    await db.insert(schema.comments).values({
      id: `cm-prod-talker-${stamp}`,
      ticketId,
      authorId: TALKER,
      bodyHtml: 'first thoughts',
    });
  });

  beforeEach(async () => {
    if (!db) return;
    await db.delete(schema.notifications).where(d.eq(schema.notifications.ticketId, ticketId));
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.projects).where(d.eq(schema.projects.id, projectId));
    for (const id of [ws, otherWs]) await db.delete(schema.workspaces).where(d.eq(schema.workspaces.id, id));
  });

  it('a comment reaches the creator, member assignees and earlier commenters, with a snippet', async () => {
    const c = await as(ACTOR, () => comments.addComment(ticketId, '**Found it**: the pager stops one page early.'));
    for (const who of [CREATOR, ASSIGNEE, TALKER]) {
      const rows = await rowsFor(who);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'comment',
        actorId: ACTOR,
        commentId: c.id,
        groupKey: `comment:${ticketId}`,
        payload: {
          ticketKey: key,
          projectId,
          snippet: 'Found it: the pager stops one page early.',
          actorIds: [ACTOR],
          count: 1,
        },
      });
    }
    expect(await rowsFor(ACTOR)).toHaveLength(0); // never yourself
    expect(await rowsFor(MUTED)).toHaveLength(0); // turned comments off
    expect(await rowsFor(BYSTANDER)).toHaveLength(0); // no role on the ticket
    expect(await rowsFor(OUTSIDER)).toHaveLength(0);
  });

  it('folds later comments into the one unread row per ticket, and starts a new one once read', async () => {
    await as(ACTOR, () => comments.addComment(ticketId, 'one'));
    const [first] = await rowsFor(CREATOR);
    await new Promise((r) => setTimeout(r, 5));
    const c2 = await as(SECOND, () => comments.addComment(ticketId, 'two'));
    await as(ACTOR, () => comments.addComment(ticketId, 'three'));
    let rows = await rowsFor(CREATOR);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.payload).toMatchObject({ count: 3, snippet: 'three' });
    expect([...(rows[0]!.payload.actorIds ?? [])].sort()).toEqual([ACTOR, SECOND].sort());
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThan(first!.updatedAt.getTime());
    expect(c2.id).toBeTruthy();

    await as(CREATOR, () => notif.markNotificationRead(first!.id));
    await as(SECOND, () => comments.addComment(ticketId, 'four'));
    rows = await rowsFor(CREATOR);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.payload).toMatchObject({ count: 1, snippet: 'four' });
  });

  it('a reply notifies the parent comment’s author once, as a reply, not also as a comment', async () => {
    const parent = await as(ASSIGNEE, () => comments.addComment(ticketId, 'is this the indexer?'));
    await db.delete(schema.notifications).where(d.eq(schema.notifications.ticketId, ticketId));
    await as(ACTOR, () => comments.addComment(ticketId, 'yes, the indexer', 'left a comment', parent.id));
    const rows = await rowsFor(ASSIGNEE);
    expect(rows.map((r) => r.kind)).toEqual(['reply']);
    expect(rows[0]!.payload).toMatchObject({ snippet: 'yes, the indexer' });
  });

  it('a mention outranks reply and comment, and a muted mention is not re-sent as a comment', async () => {
    await as(ACTOR, () => comments.addComment(ticketId, `@Creator${stamp} and @Muted${stamp}, look`));
    expect((await rowsFor(CREATOR)).map((r) => r.kind)).toEqual(['mention']);
    expect(await rowsFor(MUTED)).toHaveLength(0);
  });

  it('assigning notifies the new member assignee; unassigning while unread withdraws it', async () => {
    await as(ACTOR, () => ticketsSvc.toggleTicketAssignee(ticketId, BYSTANDER));
    const rows = await rowsFor(BYSTANDER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'assigned', actorId: ACTOR, groupKey: `assigned:${ticketId}` });
    await as(ACTOR, () => ticketsSvc.toggleTicketAssignee(ticketId, BYSTANDER));
    expect(await rowsFor(BYSTANDER)).toHaveLength(0);
  });

  it('assigning yourself is not news', async () => {
    await as(ACTOR, () => ticketsSvc.toggleTicketAssignee(ticketId, ACTOR));
    expect(await rowsFor(ACTOR)).toHaveLength(0);
    await as(ACTOR, () => ticketsSvc.toggleTicketAssignee(ticketId, ACTOR));
  });

  it('a ticket created with assignees says so', async () => {
    const created = await as(ACTOR, () =>
      ticketsSvc.createTicket({ projectId, title: 'Fresh one', stateId, assigneeIds: [SECOND] }),
    );
    const rows = await db
      .select()
      .from(schema.notifications)
      .where(d.and(d.eq(schema.notifications.recipientId, SECOND), d.eq(schema.notifications.ticketId, created.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'assigned', payload: { created: true, ticketTitle: 'Fresh one' } });
  });

  it('opening the ticket clears the opener’s mentions, comments and assignments on it, nobody else’s', async () => {
    await as(ACTOR, () => comments.addComment(ticketId, `@Assignee${stamp} ping`));
    await as(ACTOR, () => comments.addComment(ticketId, 'more'));
    const res = await as(ASSIGNEE, () => notif.markNotificationsReadForTicket(ticketId));
    expect(res.updated).toBeGreaterThan(0);
    expect((await rowsFor(ASSIGNEE)).every((r) => r.readAt !== null)).toBe(true);
    expect((await rowsFor(CREATOR)).some((r) => r.readAt === null)).toBe(true);
  });
});
