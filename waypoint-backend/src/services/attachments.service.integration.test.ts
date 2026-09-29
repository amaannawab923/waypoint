import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ROAD-162 attachments. Everything here needs things a mocked Drizzle
// cannot give: real FK cascades (a deleted comment's attachment rows), a
// real transaction (a refused claim must roll the comment back with it),
// and a real filesystem (the point of the feature is bytes on disk, and
// half the security properties are about where they land).
//
// Same skip-when-unreachable shape as comments.service.integration.test.ts
// and tickets.service.integration.test.ts.
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

describe.skipIf(!REAL_DB)('attachments against real Postgres and a real filesystem', () => {
  let service: typeof import('./attachments.service.js');
  let comments: typeof import('./comments.service.js');
  let tickets: typeof import('./tickets.service.js');
  let db: (typeof import('../db/client.js'))['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: (typeof import('drizzle-orm'))['eq'];
  let runWithIdentity: (typeof import('../lib/requestContext.js'))['runWithIdentity'];
  let attachmentFilePath: (typeof import('../lib/attachmentStore.js'))['attachmentFilePath'];
  let ForbiddenError: (typeof import('../middleware/errors.js'))['ForbiddenError'];
  let ValidationError: (typeof import('../middleware/errors.js'))['ValidationError'];
  let app: express.Express;

  // One workspace id owns everything this file writes, so afterAll's single
  // delete reclaims it through the FK cascade — this runs against the
  // developer's own dev database, not a disposable one.
  const stamp = Date.now();
  const workspaceId = `ws-itest-att-${stamp}`;
  const projectId = `proj-itest-att-${stamp}`;
  const stateId = `st-itest-att-${stamp}`;
  let ticketId: string;
  let otherTicketId: string;
  let storageRoot: string;

  const UPLOADER = 'mem-1';
  const OTHER_MEMBER = `mem-itest-att-${stamp}`;

  function asUploader<T>(fn: () => Promise<T>): Promise<T> {
    return runWithIdentity({ userId: 'user-itest', memberId: UPLOADER, workspaceId, role: 'admin' }, fn);
  }
  function asOtherMember<T>(fn: () => Promise<T>): Promise<T> {
    return runWithIdentity({ userId: 'user-itest-2', memberId: OTHER_MEMBER, workspaceId, role: 'member' }, fn);
  }

  async function fileExists(id: string): Promise<boolean> {
    try {
      await access(attachmentFilePath(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Uploads over real HTTP, through the real route (raw body parser,
   * header decoding, MIME normalizing) rather than by calling the service
   * — the parsing IS part of what these tests are about. */
  function upload(bytes: Buffer, opts: { filename?: string; contentType?: string } = {}) {
    const req = request(app).post(`/tickets/${ticketId}/attachments`);
    if (opts.filename !== undefined) req.set('x-waypoint-filename', opts.filename);
    return req.set('Content-Type', opts.contentType ?? 'application/octet-stream').send(bytes);
  }

  beforeAll(async () => {
    // Set BEFORE the storage module is first used; attachmentsRoot() reads
    // the env on every call, so a temp directory here keeps the suite from
    // writing anywhere near the developer's real ~/.waypoint.
    storageRoot = await mkdtemp(path.join(tmpdir(), 'waypoint-attachments-itest-'));
    process.env.WAYPOINT_ATTACHMENTS_DIR = storageRoot;

    // Dynamic, not top-level: db/client.ts throws on import when
    // DATABASE_URL is unset, which would fail this file instead of skipping it.
    ({ db } = await import('../db/client.js'));
    service = await import('./attachments.service.js');
    comments = await import('./comments.service.js');
    tickets = await import('./tickets.service.js');
    schema = await import('../db/schema/index.js');
    ({ eq } = await import('drizzle-orm'));
    ({ runWithIdentity } = await import('../lib/requestContext.js'));
    ({ attachmentFilePath } = await import('../lib/attachmentStore.js'));
    ({ ForbiddenError, ValidationError } = await import('../middleware/errors.js'));
    const { attachmentsRouter } = await import('../routes/attachments.routes.js');
    const { errorHandler } = await import('../middleware/errorHandler.js');

    // The real router and the real error handler, but the test's own
    // identity instead of resolveMember's — the same shape
    // routes/tickets.routes.test.ts's buildTestApp uses, except nothing
    // below this line is mocked. runWithIdentity wraps `next`, so every
    // handler further down the chain runs inside the AsyncLocalStorage
    // store that currentMemberId()/currentWorkspaceId() read.
    app = express();
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      runWithIdentity({ userId: 'user-itest', memberId: UPLOADER, workspaceId, role: 'admin' }, next);
    });
    app.use(attachmentsRouter);
    app.use(errorHandler);

    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: 'ROAD-162 attachments integration workspace',
      slug: workspaceId,
      companySize: '2-10',
      timezone: 'UTC',
    });
    await db.insert(schema.projects).values({
      id: projectId,
      workspaceId,
      name: 'ROAD-162 attachments integration project',
      identifier: `RAT${stamp % 1000}`,
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
        id: `tk-itest-att-${stamp}`,
        projectId,
        identifier: `RAT${stamp % 1000}-1`,
        sequenceId: 1,
        title: 'ROAD-162 attachments test ticket',
        stateId,
        createdById: UPLOADER,
      })
      .returning();
    ticketId = ticket.id;
    const [other] = await db
      .insert(schema.tickets)
      .values({
        id: `tk-itest-att-other-${stamp}`,
        projectId,
        identifier: `RAT${stamp % 1000}-2`,
        sequenceId: 2,
        title: 'ROAD-162 second ticket (cross-ticket claim check)',
        stateId,
        createdById: UPLOADER,
      })
      .returning();
    otherTicketId = other.id;
  });

  afterAll(async () => {
    if (db) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  describe('upload', () => {
    it('returns an unclaimed attachment, writes the bytes, and reports the size it actually wrote', async () => {
      const bytes = Buffer.from('hello attachment world');

      const res = await upload(bytes, { filename: encodeURIComponent('notes.txt'), contentType: 'text/plain' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        ticketId,
        commentId: null,
        uploaderId: UPLOADER,
        filename: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: bytes.length,
      });
      expect(typeof res.body.createdAt).toBe('string');
      expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
      expect(await readFile(attachmentFilePath(res.body.id))).toEqual(bytes);
    });

    it('keeps tickets.attachmentCount accurate', async () => {
      const before = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
      const res = await upload(Buffer.from('counts'), { filename: 'counts.txt' });
      const after = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));

      expect(after[0].attachmentCount).toBe(before[0].attachmentCount + 1);

      await asUploader(() => service.deleteAttachment(res.body.id));
      const restored = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
      expect(restored[0].attachmentCount).toBe(before[0].attachmentCount);
    });

    it('refuses a body over the 25 MB cap with a 413 that says what the cap is', async () => {
      const oversize = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);

      const res = await upload(oversize, { filename: 'huge.bin' });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('request_too_large');
      expect(res.body.detail).toContain('25 MB');
    });

    it('refuses an empty body with a 400', async () => {
      const res = await upload(Buffer.alloc(0), { filename: 'empty.txt' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('attachment body is empty');
    });

    it('never lets a hostile filename reach the disk, the row, or the header', async () => {
      // Path traversal, a NUL, a CRLF, and a non-ASCII character in one name.
      const hostile = '../../../etc/pas\u0000swd\r\nX-Injected: yes-café.png';

      const res = await upload(Buffer.from('safe bytes'), {
        filename: encodeURIComponent(hostile),
        contentType: 'image/png',
      });

      expect(res.status).toBe(201);
      // Stored name is id-derived and nothing else.
      expect(attachmentFilePath(res.body.id)).toBe(path.join(storageRoot, `${res.body.id}.bin`));
      expect(await fileExists(res.body.id)).toBe(true);
      // Display name keeps the language, loses the weapons.
      expect(res.body.filename).toBe('passwdX-Injected: yes-café.png');

      const download = await request(app).get(`/attachments/${res.body.id}/download`);
      const disposition = download.headers['content-disposition'];
      expect(disposition.startsWith("attachment; filename*=UTF-8''")).toBe(true);
      expect(disposition).not.toMatch(/[\r\n"]/);
      expect(decodeURIComponent(disposition.split("''")[1])).toBe('passwdX-Injected: yes-café.png');
    });

    it('404s an upload against a ticket in another workspace', async () => {
      await expect(
        asOtherMember(() =>
          runWithIdentity(
            { userId: 'u', memberId: OTHER_MEMBER, workspaceId: 'ws-somebody-else', role: 'member' },
            () => service.uploadAttachment(ticketId, { filename: 'x.txt', mimeType: 'text/plain', bytes: Buffer.from('x') }),
          ),
        ),
      ).rejects.toThrow(/ticket not found/);
    });
  });

  describe('serving bytes', () => {
    it('serves a safe type inline, with nosniff', async () => {
      const png = Buffer.from('89504e470d0a1a0a', 'hex');
      const uploaded = await upload(png, { filename: 'shot.png', contentType: 'image/png' });

      const res = await request(app).get(`/attachments/${uploaded.body.id}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(res.body)).toEqual(png);
    });

    it('serves a NON-safe type as a download even from the inline route', async () => {
      const uploaded = await upload(Buffer.from('<script>alert(1)</script>'), {
        filename: 'evil.html',
        contentType: 'text/html',
      });

      const inline = await request(app).get(`/attachments/${uploaded.body.id}`);

      expect(inline.status).toBe(200);
      expect(inline.headers['content-disposition'].startsWith('attachment;')).toBe(true);
      expect(inline.headers['x-content-type-options']).toBe('nosniff');
    });

    it('serves a safe type as a download from the download route', async () => {
      const uploaded = await upload(Buffer.from('plain words'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });

      const res = await request(app).get(`/attachments/${uploaded.body.id}/download`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''notes.txt");
    });

    it('404s an attachment id that does not exist', async () => {
      const res = await request(app).get('/attachments/att-nosuchid');
      expect(res.status).toBe(404);
    });
  });

  describe('listing a ticket\'s attachments', () => {
    it('returns them ordered by createdAt', async () => {
      const listed = await asUploader(() => service.listTicketAttachments(ticketId));
      const createdAts = listed.map((a) => a.createdAt);
      expect([...createdAts].sort()).toEqual(createdAts);
      expect(listed.every((a) => a.ticketId === ticketId)).toBe(true);
    });
  });

  describe('claiming on a comment', () => {
    it('claims named attachments when the comment is posted', async () => {
      const first = await upload(Buffer.from('one'), { filename: 'one.txt' });
      const second = await upload(Buffer.from('two'), { filename: 'two.txt' });

      const comment = await asUploader(() =>
        comments.addComment(ticketId, 'with files', 'left a comment', null, [
          first.body.id,
          second.body.id,
        ]),
      );

      expect(comment.attachments.map((a) => a.id)).toEqual([first.body.id, second.body.id]);
      expect(comment.attachments.every((a) => a.commentId === comment.id)).toBe(true);
    });

    it('defaults to no attachments when the field is omitted', async () => {
      const comment = await asUploader(() => comments.addComment(ticketId, 'plain comment'));
      expect(comment.attachments).toEqual([]);
    });

    it('refuses to claim an attachment belonging to a DIFFERENT ticket, and rolls the comment back', async () => {
      const foreign = await asUploader(() =>
        service.uploadAttachment(otherTicketId, {
          filename: 'elsewhere.txt',
          mimeType: 'text/plain',
          bytes: Buffer.from('elsewhere'),
        }),
      );
      const before = await asUploader(() => comments.listComments(ticketId));

      await expect(
        asUploader(() => comments.addComment(ticketId, 'thief', 'left a comment', null, [foreign.id])),
      ).rejects.toThrow(ValidationError);

      const after = await asUploader(() => comments.listComments(ticketId));
      expect(after).toHaveLength(before.length);
      const [row] = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, foreign.id));
      expect(row.commentId).toBeNull();
    });

    it('refuses to claim an attachment already claimed by a different comment', async () => {
      const file = await upload(Buffer.from('mine'), { filename: 'mine.txt' });
      await asUploader(() => comments.addComment(ticketId, 'first claimant', 'left a comment', null, [file.body.id]));

      await expect(
        asUploader(() => comments.addComment(ticketId, 'second claimant', 'left a comment', null, [file.body.id])),
      ).rejects.toThrow(ValidationError);
    });

    it('lists a thread\'s attachments in a constant number of queries, however many comments it has', async () => {
      // A ticket of its own, so the measurement doesn't depend on what the
      // rest of this file happens to have left on the shared one.
      const [thread] = await db
        .insert(schema.tickets)
        .values({
          id: `tk-itest-att-n1-${Date.now()}`,
          projectId,
          identifier: `RAT${stamp % 1000}-8`,
          sequenceId: 8,
          title: 'ROAD-162 N+1 measurement',
          stateId,
          createdById: UPLOADER,
        })
        .returning();

      async function commentWithAFile(index: number) {
        const file = await asUploader(() =>
          service.uploadAttachment(thread.id, {
            filename: `file-${index}.txt`,
            mimeType: 'text/plain',
            bytes: Buffer.from(`body ${index}`),
          }),
        );
        await asUploader(() =>
          comments.addComment(thread.id, `comment ${index}`, 'left a comment', null, [file.id]),
        );
      }

      const selectSpy = vi.spyOn(db, 'select');
      try {
        await commentWithAFile(0);
        selectSpy.mockClear();
        const one = await asUploader(() => comments.listComments(thread.id));
        const queriesForOne = selectSpy.mock.calls.length;

        for (let i = 1; i < 6; i += 1) await commentWithAFile(i);
        selectSpy.mockClear();
        const six = await asUploader(() => comments.listComments(thread.id));
        const queriesForSix = selectSpy.mock.calls.length;

        expect(one).toHaveLength(1);
        expect(six).toHaveLength(6);
        // Six times the comments, six times the attachments, same number of
        // round trips — that is the whole claim.
        expect(queriesForSix).toBe(queriesForOne);
        expect(six.every((c) => c.attachments.length === 1)).toBe(true);
      } finally {
        selectSpy.mockRestore();
        await db.delete(schema.tickets).where(eq(schema.tickets.id, thread.id));
      }
    });
  });

  describe('editing a comment\'s attachments', () => {
    it('releases a dropped file back to the ticket instead of deleting it', async () => {
      const kept = await upload(Buffer.from('kept'), { filename: 'kept.txt' });
      const dropped = await upload(Buffer.from('dropped'), { filename: 'dropped.txt' });
      const comment = await asUploader(() =>
        comments.addComment(ticketId, 'two files', 'left a comment', null, [kept.body.id, dropped.body.id]),
      );

      const edited = await asUploader(() =>
        comments.editComment(ticketId, comment.id, 'one file now', [kept.body.id]),
      );

      expect(edited.attachments.map((a) => a.id)).toEqual([kept.body.id]);
      const [droppedRow] = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, dropped.body.id));
      expect(droppedRow.commentId).toBeNull();
      expect(droppedRow.ticketId).toBe(ticketId);
      // Released, NOT destroyed.
      expect(await fileExists(dropped.body.id)).toBe(true);
    });

    it('leaves attachments untouched when attachmentIds is absent', async () => {
      const file = await upload(Buffer.from('still here'), { filename: 'stay.txt' });
      const comment = await asUploader(() =>
        comments.addComment(ticketId, 'text and a file', 'left a comment', null, [file.body.id]),
      );

      const edited = await asUploader(() => comments.editComment(ticketId, comment.id, 'just new text'));

      expect(edited.bodyHtml).toBe('just new text');
      expect(edited.attachments.map((a) => a.id)).toEqual([file.body.id]);
    });

    it('releases everything when attachmentIds is an explicit empty list', async () => {
      const file = await upload(Buffer.from('bye'), { filename: 'bye.txt' });
      const comment = await asUploader(() =>
        comments.addComment(ticketId, 'has a file', 'left a comment', null, [file.body.id]),
      );

      const edited = await asUploader(() => comments.editComment(ticketId, comment.id, 'no files', []));

      expect(edited.attachments).toEqual([]);
      const [row] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, file.body.id));
      expect(row.commentId).toBeNull();
    });

    it('re-claiming a file the comment already holds is a no-op, not a conflict', async () => {
      const file = await upload(Buffer.from('idempotent'), { filename: 'same.txt' });
      const comment = await asUploader(() =>
        comments.addComment(ticketId, 'holds a file', 'left a comment', null, [file.body.id]),
      );

      const edited = await asUploader(() =>
        comments.editComment(ticketId, comment.id, 'same file', [file.body.id]),
      );

      expect(edited.attachments.map((a) => a.id)).toEqual([file.body.id]);
    });
  });

  describe('deleting', () => {
    it('refuses a delete by anyone but the uploader, and leaves the row and file alone', async () => {
      const file = await upload(Buffer.from('not yours'), { filename: 'not-yours.txt' });

      await expect(asOtherMember(() => service.deleteAttachment(file.body.id))).rejects.toThrow(ForbiddenError);

      const [row] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, file.body.id));
      expect(row).toBeDefined();
      expect(await fileExists(file.body.id)).toBe(true);
    });

    it('removes both the row and the file for the uploader', async () => {
      const file = await upload(Buffer.from('goodbye'), { filename: 'goodbye.txt' });

      const res = await request(app).delete(`/attachments/${file.body.id}`);

      expect(res.status).toBe(204);
      const [row] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, file.body.id));
      expect(row).toBeUndefined();
      expect(await fileExists(file.body.id)).toBe(false);
    });

    it('deleting a comment deletes the rows AND files it had claimed', async () => {
      const claimed = await upload(Buffer.from('claimed'), { filename: 'claimed.txt' });
      const loose = await upload(Buffer.from('loose'), { filename: 'loose.txt' });
      const comment = await asUploader(() =>
        comments.addComment(ticketId, 'about to be deleted', 'left a comment', null, [claimed.body.id]),
      );

      await asUploader(() => comments.deleteComment(ticketId, comment.id));

      const [claimedRow] = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, claimed.body.id));
      expect(claimedRow).toBeUndefined();
      expect(await fileExists(claimed.body.id)).toBe(false);
      // An unclaimed file on the same ticket is untouched.
      const [looseRow] = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, loose.body.id));
      expect(looseRow).toBeDefined();
      expect(await fileExists(loose.body.id)).toBe(true);
    });

    it('deleting a ticket unlinks its files as well as cascading the rows', async () => {
      const [scratch] = await db
        .insert(schema.tickets)
        .values({
          id: `tk-itest-att-scratch-${Date.now()}`,
          projectId,
          identifier: `RAT${stamp % 1000}-9`,
          sequenceId: 9,
          title: 'ROAD-162 ticket-delete file cleanup',
          stateId,
          createdById: UPLOADER,
        })
        .returning();
      const file = await asUploader(() =>
        service.uploadAttachment(scratch.id, {
          filename: 'doomed.txt',
          mimeType: 'text/plain',
          bytes: Buffer.from('doomed'),
        }),
      );

      await asUploader(() => tickets.deleteTicket(scratch.id));

      const [row] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, file.id));
      expect(row).toBeUndefined();
      expect(await fileExists(file.id)).toBe(false);
    });
  });
});
