import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { attachments, tickets } from '../db/schema/index.js';
import {
  attachmentDisposition,
  deleteAttachmentFile,
  isInlineSafeMimeType,
  openAttachmentFile,
  responseContentType,
  writeAttachmentFile,
} from '../lib/attachmentStore.js';
import { mintAttachmentToken, verifyAttachmentToken } from '../lib/attachmentTokens.js';
import { newId } from '../lib/ids.js';
import { currentMemberId } from '../lib/requestContext.js';
import { assertTicketInWorkspace, workspaceProjectIdsSubquery } from '../lib/workspaceGuard.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../middleware/errors.js';
import { logActivity } from './activity.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Db = typeof db | Tx;
type AttachmentRow = typeof attachments.$inferSelect;

/** The wire shape. `createdAt` is an ISO string here rather than the raw
 * Date every other service in this file's neighbourhood returns, because
 * this one has a frozen client-side contract that says so — the two
 * serialize identically through express's res.json() either way. */
export interface Attachment {
  id: string;
  ticketId: string;
  commentId: string | null;
  uploaderId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /**
   * Where to fetch the bytes — signed and expiring, minted server-side.
   * The client must use these verbatim rather than building a URL from
   * `id`: an `<img src>` cannot send the headers the workspace check
   * reads, so a hand-built URL works in local mode and silently 404s on a
   * hosted instance. See lib/attachmentTokens.ts.
   */
  url: string;
  downloadUrl: string;
}

function toAttachment(row: AttachmentRow): Attachment {
  // One token per attachment per response. Minting on read rather than
  // storing means the lifetime is measured from when someone actually
  // looked, and a leaked URL expires without anything having to revoke it.
  const token = mintAttachmentToken(row.id);
  return {
    id: row.id,
    ticketId: row.ticketId,
    commentId: row.commentId,
    uploaderId: row.uploaderId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    url: `/attachments/${row.id}?t=${encodeURIComponent(token)}`,
    downloadUrl: `/attachments/${row.id}/download?t=${encodeURIComponent(token)}`,
  };
}

/**
 * tickets.attachmentCount was a vestigial column from the original mock
 * (nothing ever wrote it) — recomputed here from the rows themselves,
 * exactly the way addTicketLink/removeTicketLink maintain linkCount, rather
 * than incremented and decremented. A count that is derived on every write
 * cannot drift; one that is stepped can, and there is no way to notice.
 *
 * It counts EVERY attachment on the ticket, claimed by a comment or not —
 * "how many files are on this ticket" is the question a list row is asking,
 * and a file uploaded into a composer is on the ticket from the moment it
 * lands, which is exactly what the nullable commentId means.
 */
export async function recomputeAttachmentCount(tx: Db, ticketId: string): Promise<void> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(attachments)
    .where(eq(attachments.ticketId, ticketId));
  await tx.update(tickets).set({ attachmentCount: n, updatedAt: new Date() }).where(eq(tickets.id, ticketId));
}

export interface UploadAttachmentInput {
  /** Already decoded and sanitized by lib/attachmentStore.ts — this is a
   * display name, and nothing downstream may treat it as a path. */
  filename: string;
  /** Already normalized to a bare `type/subtype`. */
  mimeType: string;
  bytes: Buffer;
}

/**
 * Stores one uploaded file against a ticket, unclaimed by any comment.
 *
 * The file is written BEFORE the row exists, and unlinked if the insert
 * fails. The other order would let a committed row point at bytes that
 * were never written — a broken download with nothing to retry — whereas
 * this order's worst case is a file with no row, which is invisible to
 * every reader and reclaimable.
 */
export async function uploadAttachment(ticketId: string, input: UploadAttachmentInput): Promise<Attachment> {
  await assertTicketInWorkspace(ticketId);
  if (input.bytes.length === 0) {
    // Not a 404 and not a crash: an empty body is a client mistake
    // (a failed read, a cancelled file picker), and ValidationError is
    // what this codebase's 400s are made of.
    throw new ValidationError('attachment body is empty');
  }

  const id = newId('att');
  await writeAttachmentFile(id, input.bytes);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(attachments)
        .values({
          id,
          ticketId,
          commentId: null,
          uploaderId: currentMemberId(),
          filename: input.filename,
          mimeType: input.mimeType,
          // The length actually written, never a client-claimed
          // content-length: the two can disagree, and only one of them is
          // a fact about the file this API now holds.
          sizeBytes: input.bytes.length,
        })
        .returning();
      await recomputeAttachmentCount(tx, ticketId);
      await logActivity(tx, {
        ticketId,
        actorId: currentMemberId(),
        verb: 'attachment_added',
        detail: `attached ${input.filename}`,
        createdAt: row.createdAt,
      });
      return toAttachment(row);
    });
  } catch (err) {
    await deleteAttachmentFile(id);
    throw err;
  }
}

export async function listTicketAttachments(ticketId: string): Promise<Attachment[]> {
  await assertTicketInWorkspace(ticketId);
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.ticketId, ticketId))
    .orderBy(asc(attachments.createdAt));
  return rows.map(toAttachment);
}

/**
 * One attachment, scoped to the caller's workspace through its ticket's
 * project — the same 404-never-403 discipline workspaceGuard.ts explains,
 * reached by joining rather than by a second query because this runs on
 * every byte-serving request.
 */
/**
 * One attachment by id, with NO workspace scoping — only ever reached once
 * a valid signature for this exact id has been verified, which is itself
 * evidence the caller was handed this URL by an authorized read. Kept as
 * its own named function rather than a boolean argument on the scoped one
 * below, so "unscoped" can never be passed by accident.
 */
async function getAttachmentById(id: string): Promise<AttachmentRow> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  if (!row) throw new NotFoundError('attachment');
  return row;
}

async function getAttachmentInWorkspace(id: string): Promise<AttachmentRow> {
  const [row] = await db
    .select({ attachment: attachments })
    .from(attachments)
    .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
    .where(and(eq(attachments.id, id), inArray(tickets.projectId, workspaceProjectIdsSubquery())));
  if (!row) throw new NotFoundError('attachment');
  return row.attachment;
}

export interface AttachmentDownload {
  attachment: Attachment;
  contentType: string;
  /** The exact Content-Disposition to send. */
  disposition: string;
  sizeBytes: number;
  stream: Awaited<ReturnType<typeof openAttachmentFile>>['stream'];
}

/**
 * Resolves one attachment for serving.
 *
 * `preferInline` is a REQUEST, not a decision: the inline route asks for
 * it, and a type outside the inline allowlist gets `attachment` anyway.
 * Putting that override here rather than in the route means there is no
 * endpoint — present or future — that can serve active content inline from
 * this API's origin by forgetting to check.
 *
 * sizeBytes comes from the file on disk, not from the row, so a
 * Content-Length is never a promise the stream can't keep.
 */
export async function openAttachmentForResponse(
  id: string,
  preferInline: boolean,
  /** A `?t=` signature from the URL, if one was presented. */
  token?: unknown,
): Promise<AttachmentDownload> {
  // Either proof is enough, and they cover different callers: the workspace
  // join is what an authenticated API request satisfies, the signature is
  // what a bare <img src> can carry. The token is checked first so a page
  // full of just-listed images skips the join entirely.
  const row = verifyAttachmentToken(id, token)
    ? await getAttachmentById(id)
    : await getAttachmentInWorkspace(id);
  let opened: Awaited<ReturnType<typeof openAttachmentFile>>;
  try {
    opened = await openAttachmentFile(row.id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // The row outlived its bytes (a restore that skipped the files, a
      // hand-deleted directory). 404 is honest; a 500 would suggest the
      // caller should retry.
      throw new NotFoundError('attachment file');
    }
    throw err;
  }
  const inline = preferInline && isInlineSafeMimeType(row.mimeType);
  return {
    attachment: toAttachment(row),
    contentType: responseContentType(row.mimeType),
    disposition: inline ? 'inline' : attachmentDisposition(row.filename),
    sizeBytes: opened.sizeBytes,
    stream: opened.stream,
  };
}

/**
 * Uploader-only delete — the same single-enforcement-point reasoning as
 * comments.service.ts's deleteComment (there is no role-based authz layer
 * in this backend; see ForbiddenError's comment in middleware/errors.ts).
 *
 * The file is unlinked after the transaction commits, not inside it: a
 * filesystem unlink cannot be rolled back, so doing it first would destroy
 * the bytes of a row that a later rollback keeps alive.
 */
export async function deleteAttachment(id: string): Promise<void> {
  const row = await getAttachmentInWorkspace(id);
  if (row.uploaderId !== currentMemberId()) {
    throw new ForbiddenError('Only the uploader can delete this attachment.');
  }
  await db.transaction(async (tx) => {
    await tx.delete(attachments).where(eq(attachments.id, id));
    await recomputeAttachmentCount(tx, row.ticketId);
    await logActivity(tx, {
      ticketId: row.ticketId,
      actorId: currentMemberId(),
      verb: 'attachment_removed',
      detail: `removed ${row.filename}`,
    });
  });
  await deleteAttachmentFile(row.id);
}

/**
 * Points a set of attachments at one comment, and (when `replace` is true)
 * releases every other attachment currently on that comment back to the
 * ticket.
 *
 * `attachmentIds` on an EDIT is the full set after the edit, not a delta —
 * so a file the person removed from the composer is released (commentId →
 * null), never deleted: it is still their file on still their ticket, and
 * "I took it out of this comment" is not "destroy it". Deleting is its own
 * endpoint, and its own decision.
 *
 * Runs inside the caller's transaction so a comment and its claims commit
 * or fail together.
 */
export async function claimAttachmentsForComment(
  tx: Tx,
  params: { ticketId: string; commentId: string; attachmentIds: string[]; replace: boolean },
): Promise<void> {
  const wanted = Array.from(new Set(params.attachmentIds));

  if (wanted.length > 0) {
    const rows = await tx.select().from(attachments).where(inArray(attachments.id, wanted));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const attachmentId of wanted) {
      const row = byId.get(attachmentId);
      // One message for "doesn't exist", "belongs to another ticket", and
      // "already claimed by a different comment" on purpose: the caller
      // holding an id they shouldn't have must not learn WHICH of those it
      // is, and every one of the three is the same client bug from this
      // side — a stale id. ValidationError (400), not NotFound, matching
      // addComment's parentId cross-ticket check exactly.
      if (!row || row.ticketId !== params.ticketId) {
        throw new ValidationError('attachmentIds must reference attachments on this ticket');
      }
      if (row.commentId !== null && row.commentId !== params.commentId) {
        throw new ValidationError('attachmentIds must reference attachments on this ticket');
      }
    }
  }

  // Release before claim. The release predicate excludes `wanted` anyway,
  // so the order is not load-bearing for correctness — it is load-bearing
  // for reading the intent: this comment's set becomes exactly `wanted`.
  if (params.replace) {
    const stillMine =
      wanted.length > 0
        ? and(eq(attachments.commentId, params.commentId), notInArray(attachments.id, wanted))
        : eq(attachments.commentId, params.commentId);
    await tx.update(attachments).set({ commentId: null }).where(stillMine);
  }

  if (wanted.length > 0) {
    await tx.update(attachments).set({ commentId: params.commentId }).where(inArray(attachments.id, wanted));
  }
}

/**
 * Every attachment claimed by any of `commentIds`, grouped by comment and
 * ordered by createdAt.
 *
 * ONE query for a whole thread, not one per comment — the same shape
 * listComments already uses for reactions, and the reason that function
 * stays a constant number of round trips however long the thread gets.
 */
export async function attachmentsByCommentIds(
  runner: Db,
  commentIds: string[],
): Promise<Map<string, Attachment[]>> {
  const byComment = new Map<string, Attachment[]>();
  if (commentIds.length === 0) return byComment;
  const rows = await runner
    .select()
    .from(attachments)
    .where(inArray(attachments.commentId, commentIds))
    .orderBy(asc(attachments.createdAt));
  for (const row of rows) {
    if (!row.commentId) continue;
    const list = byComment.get(row.commentId);
    if (list) list.push(toAttachment(row));
    else byComment.set(row.commentId, [toAttachment(row)]);
  }
  return byComment;
}

/** One comment's attachments — the single-comment case of the grouping
 * above, for add/edit's return value. */
export async function listCommentAttachments(runner: Db, commentId: string): Promise<Attachment[]> {
  const rows = await runner
    .select()
    .from(attachments)
    .where(eq(attachments.commentId, commentId))
    .orderBy(asc(attachments.createdAt));
  return rows.map(toAttachment);
}

/**
 * Deletes the rows for everything one comment has claimed and returns the
 * ids whose files the caller must now unlink — AFTER its transaction
 * commits, for the same un-rollback-able-unlink reason deleteAttachment
 * gives above.
 *
 * The rows would go anyway (commentId cascades), but a cascade cannot
 * unlink a file, and a file with no row is unreachable forever. Deleting
 * explicitly is what makes the id list exist.
 */
export async function deleteAttachmentsForComment(tx: Tx, commentId: string): Promise<string[]> {
  const removed = await tx
    .delete(attachments)
    .where(eq(attachments.commentId, commentId))
    .returning({ id: attachments.id });
  return removed.map((row) => row.id);
}

/** Exported for the ticket-delete path, which must unlink files before
 * letting the ticket's FK cascade take the rows with it. */
export async function attachmentIdsForTicket(runner: Db, ticketId: string): Promise<string[]> {
  const rows = await runner
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.ticketId, ticketId));
  return rows.map((row) => row.id);
}
