import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

// ROAD-162: @mentions produce real notifications. Needs a real database
// because the properties that matter are transactional and relational: the
// notification commits or rolls back with its comment, and recipients are
// scoped to the actor's workspace through the members table.
//
// Same skip-when-unreachable shape as the other *.integration.test.ts files.
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

describe.skipIf(!REAL_DB)('@mention notifications against real Postgres', () => {
  let comments: typeof import('./comments.service.js');
  let db: (typeof import('../db/client.js'))['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: (typeof import('drizzle-orm'))['eq'];
  let runWithIdentity: (typeof import('../lib/requestContext.js'))['runWithIdentity'];

  const stamp = Date.now();
  const workspaceId = `ws-itest-mention-${stamp}`;
  const otherWorkspaceId = `ws-itest-mention-other-${stamp}`;
  const projectId = `proj-itest-mention-${stamp}`;
  const stateId = `st-itest-mention-${stamp}`;
  const ticketId = `tk-itest-mention-${stamp}`;

  const AUTHOR = `mem-itest-author-${stamp}`;
  const PRIYA = `mem-itest-priya-${stamp}`;
  const QUIET = `mem-itest-quiet-${stamp}`;
  const OUTSIDER = `mem-itest-outsider-${stamp}`;

  function asAuthor<T>(fn: () => Promise<T>): Promise<T> {
    return runWithIdentity({ userId: 'user-itest', memberId: AUTHOR, workspaceId, role: 'admin' }, fn);
  }

  async function notificationsFor(recipientId: string) {
    return db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, recipientId));
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    comments = await import('./comments.service.js');
    schema = await import('../db/schema/index.js');
    ({ eq } = await import('drizzle-orm'));
    ({ runWithIdentity } = await import('../lib/requestContext.js'));

    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.insert(schema.workspaces).values({
        id,
        name: `ROAD-162 mentions ${id}`,
        slug: id,
        companySize: '2-10',
        timezone: 'UTC',
      });
    }
    const member = (id: string, displayName: string, ws: string, notificationPrefs: unknown = null) => ({
      id,
      workspaceId: ws,
      fullName: `${displayName} Tester`,
      displayName,
      email: `${id}@example.test`,
      avatarColor: '#000000',
      notificationPrefs,
    });
    await db.insert(schema.members).values([
      member(AUTHOR, `Author${stamp}`, workspaceId),
      member(PRIYA, `Priya${stamp}`, workspaceId),
      // Has switched "Notify on mentions" off in their settings.
      member(QUIET, `Quiet${stamp}`, workspaceId, { mentions: false }),
      // Same kind of name, but in a DIFFERENT workspace.
      member(OUTSIDER, `Outsider${stamp}`, otherWorkspaceId),
    ]);
    await db.insert(schema.projects).values({
      id: projectId,
      workspaceId,
      name: 'ROAD-162 mentions project',
      identifier: `RMN${stamp % 1000}`,
      icon: 'folder',
      coverGradientStart: '#000000',
      coverGradientEnd: '#ffffff',
      timezone: 'UTC',
      automations: {},
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
      identifier: `RMN${stamp % 1000}-1`,
      sequenceId: 1,
      title: 'Search indexer misses the last page',
      stateId,
      createdById: AUTHOR,
    });
  });

  afterAll(async () => {
    if (!db) return;
    // Project first: tickets.createdById RESTRICTs member deletion, so a
    // workspace-first delete fails while the ticket still names its author.
    // The project cascades to tickets, comments and ticket notifications;
    // the workspaces then cascade to the members.
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
  });

  it('notifies a mentioned member, deep-linked to the exact comment, with a display snapshot', async () => {
    const c = await asAuthor(() => comments.addComment(ticketId, `@Priya${stamp} can you check this?`));
    const rows = await notificationsFor(PRIYA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'mention',
      actorId: AUTHOR,
      ticketId,
      commentId: c.id,
      readAt: null,
      groupKey: `mention:${c.id}`,
      // The client renders the sentence; the row no longer freezes one.
      message: null,
      payload: { v: 1, ticketKey: `RMN${stamp % 1000}-1`, ticketTitle: 'Search indexer misses the last page' },
    });
  });

  it('does not notify the author for mentioning themselves', async () => {
    await asAuthor(() => comments.addComment(ticketId, `note to self @Author${stamp}`));
    expect(await notificationsFor(AUTHOR)).toHaveLength(0);
  });

  it("honors a member's own 'Notify on mentions' being switched off", async () => {
    await asAuthor(() => comments.addComment(ticketId, `@Quiet${stamp} fyi`));
    expect(await notificationsFor(QUIET)).toHaveLength(0);
  });

  it('never reaches a member of another workspace, whatever name is typed', async () => {
    await asAuthor(() => comments.addComment(ticketId, `@Outsider${stamp} are you there?`));
    expect(await notificationsFor(OUTSIDER)).toHaveLength(0);
  });

  it('on an edit, notifies only the mentions the edit added', async () => {
    const before = (await notificationsFor(PRIYA)).length;
    const c = await asAuthor(() => comments.addComment(ticketId, `first draft, cc @Priya${stamp}`));
    expect(await notificationsFor(PRIYA)).toHaveLength(before + 1);

    // A typo fix that keeps the same mention must not notify again.
    await asAuthor(() => comments.editComment(ticketId, c.id, `first draft (fixed), cc @Priya${stamp}`));
    expect(await notificationsFor(PRIYA)).toHaveLength(before + 1);

    // Adding a mention in an edit notifies only the newly added person.
    const quietBefore = (await notificationsFor(QUIET)).length;
    await asAuthor(() => comments.editComment(ticketId, c.id, `cc @Priya${stamp} and @Author${stamp}`));
    expect(await notificationsFor(PRIYA)).toHaveLength(before + 1);
    expect(await notificationsFor(AUTHOR)).toHaveLength(0); // self, still nothing
    expect(await notificationsFor(QUIET)).toHaveLength(quietBefore);
  });

  it('keeps one open row per comment when an edit drops a mention and puts it back', async () => {
    const before = (await notificationsFor(PRIYA)).length;
    const c = await asAuthor(() => comments.addComment(ticketId, `@Priya${stamp} please look`));
    await asAuthor(() => comments.editComment(ticketId, c.id, 'please look'));
    // Re-added while the first notification is still unread: the open-group
    // unique index turns the second insert into a no-op, not a second row.
    await asAuthor(() => comments.editComment(ticketId, c.id, `@Priya${stamp} please look again`));
    const rows = (await notificationsFor(PRIYA)).filter((r) => r.commentId === c.id);
    expect(rows).toHaveLength(1);
    expect(await notificationsFor(PRIYA)).toHaveLength(before + 1);
  });

  it('writes one notification per person, however often they are mentioned', async () => {
    const before = (await notificationsFor(PRIYA)).length;
    await asAuthor(() => comments.addComment(ticketId, `@Priya${stamp} @Priya${stamp} @Priya${stamp}`));
    expect(await notificationsFor(PRIYA)).toHaveLength(before + 1);
  });

  it('rolls the notification back with a comment that fails to save', async () => {
    const before = (await notificationsFor(PRIYA)).length;
    // Claiming an attachment that does not exist fails inside the comment's
    // transaction, so the comment never exists, and neither may its
    // notification.
    await expect(
      asAuthor(() =>
        comments.addComment(ticketId, `@Priya${stamp} see attached`, 'left a comment', null, [
          'att-does-not-exist',
        ]),
      ),
    ).rejects.toThrow();
    expect(await notificationsFor(PRIYA)).toHaveLength(before);
  });
});
