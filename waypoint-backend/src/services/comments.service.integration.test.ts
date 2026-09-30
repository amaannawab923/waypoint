import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

// ROAD-162 (comment edit, reply threading, reactions). Three things this
// file exists to prove that a mocked-Drizzle unit test can't:
//   - the (comment_id, actor_id, emoji) unique constraint on
//     comment_reactions is real, at the database level, not just something
//     the service happens to check first;
//   - editComment/deleteComment's author-only gate reads currentMemberId()
//     against the row Postgres actually has, not a value the mock handed
//     back;
//   - addComment's parentId cross-check (must be a comment on the SAME
//     ticket) runs against a real second ticket, not an assumed one.
// Same skip-when-unreachable shape as tickets.service.integration.test.ts /
// proposals.service.integration.test.ts / ticketRefs.service.integration.test.ts.
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

describe.skipIf(!REAL_DB)('comments.service against real Postgres', () => {
  let service: typeof import('./comments.service.js');
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: typeof import('drizzle-orm')['eq'];
  let runWithIdentity: typeof import('../lib/requestContext.js')['runWithIdentity'];
  let ForbiddenError: typeof import('../middleware/errors.js')['ForbiddenError'];
  let ValidationError: typeof import('../middleware/errors.js')['ValidationError'];
  let NotFoundError: typeof import('../middleware/errors.js')['NotFoundError'];

  // Everything this file writes hangs off one workspace id, so afterAll's
  // single delete reclaims it all through the FK cascade (workspace ->
  // project -> tickets -> comments -> comment_reactions) — this runs
  // against the developer's own dev database, not a disposable one, and
  // must not leave rows behind.
  const workspaceId = `ws-itest-cm-${Date.now()}`;
  const projectId = `proj-itest-cm-${Date.now()}`;
  const stateId = `st-itest-cm-${Date.now()}`;
  let ticketId: string;
  let otherTicketId: string;

  // mem-1 is the real seeded member (createdById's FK target); mem-2 is a
  // bare id with no row of its own — comments.authorId/comment_reactions.
  // actorId carry no FK (polymorphic, same reasoning as ticketAssignees —
  // see schema/tickets.ts), so a second member never needs to actually
  // exist for these tests to be honest about "a different author".
  const AUTHOR = 'mem-1';
  const OTHER_MEMBER = 'mem-itest-cm-2';

  function asAuthor<T>(fn: () => Promise<T>): Promise<T> {
    return runWithIdentity({ userId: 'user-itest', memberId: AUTHOR, workspaceId, role: 'admin' }, fn);
  }
  function asOtherMember<T>(fn: () => Promise<T>): Promise<T> {
    return runWithIdentity({ userId: 'user-itest-2', memberId: OTHER_MEMBER, workspaceId, role: 'member' }, fn);
  }

  beforeAll(async () => {
    // Dynamic, not top-level: db/client.ts throws on import when
    // DATABASE_URL is unset, which would fail this file instead of skipping it.
    ({ db } = await import('../db/client.js'));
    service = await import('./comments.service.js');
    schema = await import('../db/schema/index.js');
    ({ eq } = await import('drizzle-orm'));
    ({ runWithIdentity } = await import('../lib/requestContext.js'));
    ({ ForbiddenError, ValidationError, NotFoundError } = await import('../middleware/errors.js'));

    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: 'ROAD-162 integration test workspace',
      slug: workspaceId,
      companySize: '2-10',
      timezone: 'UTC',
    });
    await db.insert(schema.projects).values({
      id: projectId,
      workspaceId,
      name: 'ROAD-162 integration test project',
      identifier: 'RCM',
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
    const [ticket] = await db
      .insert(schema.tickets)
      .values({
        id: `tk-itest-cm-${Date.now()}`,
        projectId,
        identifier: 'RCM-1',
        sequenceId: 1,
        title: 'ROAD-162 test ticket',
        stateId,
        createdById: AUTHOR,
      })
      .returning();
    ticketId = ticket.id;
    const [other] = await db
      .insert(schema.tickets)
      .values({
        id: `tk-itest-cm-other-${Date.now()}`,
        projectId,
        identifier: 'RCM-2',
        sequenceId: 2,
        title: 'ROAD-162 second ticket (cross-ticket parentId check)',
        stateId,
        createdById: AUTHOR,
      })
      .returning();
    otherTicketId = other.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  });

  describe('author-only edit', () => {
    it('lets the author edit their own comment and sets updatedAt', async () => {
      const comment = await asAuthor(() => service.addComment(ticketId, 'original text'));
      expect(comment.updatedAt).toBeNull();

      const edited = await asAuthor(() => service.editComment(ticketId, comment.id, 'edited text'));

      expect(edited.bodyHtml).toBe('edited text');
      expect(edited.updatedAt).not.toBeNull();
    });

    it('refuses to let a different member edit the comment', async () => {
      const comment = await asAuthor(() => service.addComment(ticketId, 'author-only edit check'));

      await expect(
        asOtherMember(() => service.editComment(ticketId, comment.id, 'hijacked')),
      ).rejects.toThrow(ForbiddenError);

      // The refusal must not have touched the row.
      const [row] = await db.select().from(schema.comments).where(eq(schema.comments.id, comment.id));
      expect(row.bodyHtml).toBe('author-only edit check');
      expect(row.updatedAt).toBeNull();
    });

    it('404s editing a comment that does not exist on this ticket', async () => {
      await expect(
        asAuthor(() => service.editComment(ticketId, 'cm-does-not-exist', 'x')),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('author-only delete', () => {
    it('refuses to let a different member delete the comment', async () => {
      const comment = await asAuthor(() => service.addComment(ticketId, 'author-only delete check'));

      await expect(asOtherMember(() => service.deleteComment(ticketId, comment.id))).rejects.toThrow(
        ForbiddenError,
      );

      const [row] = await db.select().from(schema.comments).where(eq(schema.comments.id, comment.id));
      expect(row).toBeDefined();
    });

    it('lets the author delete their own comment, and orphans (not cascades) a reply under it', async () => {
      const root = await asAuthor(() => service.addComment(ticketId, 'root, about to be deleted'));
      const reply = await asAuthor(() => service.addComment(ticketId, 'a reply', 'left a comment', root.id));

      await asAuthor(() => service.deleteComment(ticketId, root.id));

      const [rootRow] = await db.select().from(schema.comments).where(eq(schema.comments.id, root.id));
      expect(rootRow).toBeUndefined();
      const [replyRow] = await db.select().from(schema.comments).where(eq(schema.comments.id, reply.id));
      expect(replyRow).toBeDefined();
      expect(replyRow.parentId).toBeNull();
    });
  });

  describe('reply threading (parentId)', () => {
    it('threads a reply under its parent', async () => {
      const root = await asAuthor(() => service.addComment(ticketId, 'root comment'));
      const reply = await asAuthor(() =>
        service.addComment(ticketId, 'a reply', 'left a comment', root.id),
      );

      expect(reply.parentId).toBe(root.id);
      const listed = await asAuthor(() => service.listComments(ticketId));
      expect(listed.find((c) => c.id === reply.id)?.parentId).toBe(root.id);
    });

    it('refuses a parentId that names a comment on a DIFFERENT ticket', async () => {
      const foreignRoot = await asAuthor(() => service.addComment(otherTicketId, 'lives on the other ticket'));

      await expect(
        asAuthor(() => service.addComment(ticketId, 'cross-ticket reply attempt', 'left a comment', foreignRoot.id)),
      ).rejects.toThrow(ValidationError);
    });

    it('refuses a parentId that does not exist at all', async () => {
      await expect(
        asAuthor(() => service.addComment(ticketId, 'reply to nothing', 'left a comment', 'cm-nonexistent')),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('reactions', () => {
    it('toggles a reaction on, then off, for the same actor and emoji', async () => {
      const comment = await asAuthor(() => service.addComment(ticketId, 'react to me'));

      const afterFirst = await asAuthor(() => service.toggleCommentReaction(ticketId, comment.id, '👍'));
      expect(afterFirst).toEqual([{ emoji: '👍', actorIds: [AUTHOR] }]);

      const afterSecond = await asAuthor(() => service.toggleCommentReaction(ticketId, comment.id, '👍'));
      expect(afterSecond).toEqual([]);
    });

    it('keeps two different actors reacting with the same emoji as two entries in that emoji\'s actor list', async () => {
      const comment = await asAuthor(() => service.addComment(ticketId, 'popular comment'));

      await asAuthor(() => service.toggleCommentReaction(ticketId, comment.id, '🔥'));
      const afterBoth = await asOtherMember(() => service.toggleCommentReaction(ticketId, comment.id, '🔥'));

      expect(afterBoth).toHaveLength(1);
      expect(afterBoth[0].emoji).toBe('🔥');
      expect(new Set(afterBoth[0].actorIds)).toEqual(new Set([AUTHOR, OTHER_MEMBER]));
    });

    it('nests grouped reactions onto listComments, keyed by emoji', async () => {
      const comment = await asAuthor(() => service.addComment(ticketId, 'multi-emoji comment'));
      await asAuthor(() => service.toggleCommentReaction(ticketId, comment.id, '🚀'));
      await asOtherMember(() => service.toggleCommentReaction(ticketId, comment.id, '🎉'));

      const listed = await asAuthor(() => service.listComments(ticketId));
      const row = listed.find((c) => c.id === comment.id);
      expect(row?.reactions).toEqual(
        expect.arrayContaining([
          { emoji: '🚀', actorIds: [AUTHOR] },
          { emoji: '🎉', actorIds: [OTHER_MEMBER] },
        ]),
      );
    });

    it('enforces the (comment, actor, emoji) unique constraint at the database level', async () => {
      const comment = await asAuthor(() => service.addComment(ticketId, 'constraint check'));
      await db
        .insert(schema.commentReactions)
        .values({ id: 'rx-itest-dup-1', commentId: comment.id, actorId: AUTHOR, emoji: '⭐' });

      await expect(
        db
          .insert(schema.commentReactions)
          .values({ id: 'rx-itest-dup-2', commentId: comment.id, actorId: AUTHOR, emoji: '⭐' }),
      ).rejects.toThrow();
    });

    it('rejects an absurdly long emoji value', async () => {
      const comment = await asAuthor(() => service.addComment(ticketId, 'bad emoji check'));

      await expect(
        asAuthor(() => service.toggleCommentReaction(ticketId, comment.id, 'x'.repeat(50))),
      ).rejects.toThrow(ValidationError);
    });
  });
});
