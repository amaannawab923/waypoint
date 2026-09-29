import { eq, and, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, commentReactions } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { currentMemberId } from '../lib/requestContext.js';
import { assertTicketInWorkspace } from '../lib/workspaceGuard.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../middleware/errors.js';
import { logActivity } from './activity.service.js';
import { deleteAttachmentFile } from '../lib/attachmentStore.js';
import {
  attachmentsByCommentIds,
  claimAttachmentsForComment,
  deleteAttachmentsForComment,
  listCommentAttachments,
  recomputeAttachmentCount,
} from './attachments.service.js';

/** One comment's reactions, grouped by emoji — the shape listComments below
 * nests onto each row. actorIds is every member who reacted with that exact
 * emoji, in no particular guaranteed order (the frontend only ever needs
 * "who", to render names/avatars and to know whether the current member is
 * among them — never a stable ordering of reactors). */
export interface CommentReactionSummary {
  emoji: string;
  actorIds: string[];
}

// limit caps how many rows the query itself fetches (undefined means
// unlimited, preserving prior behavior for callers that don't pass one —
// see the REST route in tickets.routes.ts). Ordered by createdAt so a
// limited call has a deterministic, meaningful "first N" rather than
// whatever order the table scan happens to return.
// AT11 (ROAD-146) review fix: called directly from routes/tickets.routes.ts
// with a bare req.params.id — this file's own boundary, not one that
// inherits scoping from an already-guarded caller the way logActivity's
// tx-scoped callers do.
//
// ROAD-162: nests each comment's reactions (grouped by emoji) onto the row
// in one extra query rather than making the frontend fan out a request per
// comment — the same "one list call, nested arrays" shape tickets.service.ts
// already uses for links/labels on a ticket.
export async function listComments(ticketId: string, limit?: number) {
  await assertTicketInWorkspace(ticketId);
  const query = db
    .select()
    .from(comments)
    .where(eq(comments.ticketId, ticketId))
    .orderBy(asc(comments.createdAt));
  const rows = limit ? await query.limit(limit) : await query;
  if (rows.length === 0) return [];

  const commentIds = rows.map((r) => r.id);
  const reactionRows = await db
    .select()
    .from(commentReactions)
    .where(inArray(commentReactions.commentId, commentIds));
  // ROAD-162 attachments: ONE query for the whole thread, grouped in
  // memory below — the same discipline the reaction query above already
  // follows, and the reason this function stays three round trips whether
  // the ticket has two comments or two hundred.
  const attachmentsByComment = await attachmentsByCommentIds(db, commentIds);
  const byComment = new Map<string, Map<string, string[]>>();
  for (const r of reactionRows) {
    let byEmoji = byComment.get(r.commentId);
    if (!byEmoji) {
      byEmoji = new Map();
      byComment.set(r.commentId, byEmoji);
    }
    const actorIds = byEmoji.get(r.emoji);
    if (actorIds) actorIds.push(r.actorId);
    else byEmoji.set(r.emoji, [r.actorId]);
  }

  return rows.map((row) => ({
    ...row,
    reactions: Array.from(byComment.get(row.id)?.entries() ?? []).map(
      ([emoji, actorIds]): CommentReactionSummary => ({ emoji, actorIds }),
    ),
    attachments: attachmentsByComment.get(row.id) ?? [],
  }));
}

export async function addComment(
  ticketId: string,
  bodyHtml: string,
  /** The activity line; the default is a person's own comment. */
  activityDetail = 'left a comment',
  /** ROAD-162: the comment this replies to, one level deep — see
   * groupCommentsIntoThreads for how a page renders a chain deeper than
   * that, or a parentId this ticket doesn't recognize. */
  parentId: string | null = null,
  /** ROAD-162: files already uploaded against this ticket (POST
   * /tickets/:id/attachments, which leaves them unclaimed) that this
   * comment now claims. Uploading and posting are separate steps because
   * a person drops a file into a composer long before they send it — see
   * the nullable commentId in schema/tickets.ts. */
  attachmentIds: string[] = [],
) {
  await assertTicketInWorkspace(ticketId);
  if (parentId !== null) {
    // Must be a real comment ON THIS TICKET — not just any comment id, which
    // would let a reply thread across two unrelated tickets. A parentId that
    // fails this is a client bug (a stale id from a since-navigated-away
    // ticket, say), not a 404-worthy "someone deleted it mid-request" —
    // ValidationError is what every other cross-reference check in this
    // schema layer throws for "this id doesn't belong here" (see
    // addTicketLinkSchema's URL scheme check for the same 400-not-404 call).
    const [parent] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.id, parentId), eq(comments.ticketId, ticketId)));
    if (!parent) throw new ValidationError('parentId must reference a comment on this ticket');
  }
  return db.transaction(async (tx) => {
    const [comment] = await tx
      .insert(comments)
      .values({ id: newId('cm'), ticketId, authorId: currentMemberId(), bodyHtml, parentId })
      .returning();
    // Inside the same transaction as the insert: a comment that claims
    // files it turns out not to be allowed to claim must not exist at all,
    // rather than post without them and leave the person to notice.
    // `replace: false` — a brand-new comment owns nothing to release.
    await claimAttachmentsForComment(tx, {
      ticketId,
      commentId: comment.id,
      attachmentIds,
      replace: false,
    });
    await logActivity(tx, {
      ticketId,
      actorId: currentMemberId(),
      verb: 'commented',
      detail: activityDetail,
      createdAt: comment.createdAt,
    });
    return {
      ...comment,
      reactions: [] as CommentReactionSummary[],
      attachments: await listCommentAttachments(tx, comment.id),
    };
  });
}

/** Throws NotFoundError('comment') unless `commentId` is a real comment on
 * `ticketId` — the shared existence check editComment, deleteComment, and
 * toggleCommentReaction all need before doing anything else. Callers must
 * have already run assertTicketInWorkspace themselves (this doesn't repeat
 * it), matching every other helper in this file. */
async function getCommentOrThrow(ticketId: string, commentId: string) {
  const [row] = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.ticketId, ticketId)));
  if (!row) throw new NotFoundError('comment');
  return row;
}

/**
 * Author-only edit (ROAD-162). This is the ONE enforcement point — there is
 * no role-based authz layer anywhere in this backend (verified: the sole
 * `role !==` check in the whole codebase is workspaces.service.ts's invite
 * flow), so a middleware can't be relied on to have already refused this,
 * and this check has to happen here against currentMemberId() rather than
 * being assumed done upstream.
 *
 * Sets updatedAt to now() unconditionally on every edit (even one that
 * happens to submit the same text back) — this is a "the author touched
 * it" marker, not a diff of whether the content actually changed, matching
 * how the frontend's "(edited)" label reads it.
 */
export async function editComment(
  ticketId: string,
  commentId: string,
  bodyHtml: string,
  /** ROAD-162: when present, the FULL set of attachments this comment
   * should have after the edit — not a delta. A file currently on the
   * comment and absent from this list is released back to the ticket
   * (commentId → null), NOT deleted: removing a file from a comment and
   * destroying it are different intents, and only one of them has an
   * endpoint (DELETE /attachments/:id).
   *
   * `undefined` (the field omitted entirely, which is not the same as `[]`)
   * leaves the comment's attachments exactly as they were — so a client
   * that only edits text never has to know or resend what is attached. */
  attachmentIds?: string[],
) {
  await assertTicketInWorkspace(ticketId);
  const existing = await getCommentOrThrow(ticketId, commentId);
  if (existing.authorId !== currentMemberId()) {
    throw new ForbiddenError('Only the comment author can edit this comment.');
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(comments)
      .set({ bodyHtml, updatedAt: new Date() })
      .where(eq(comments.id, commentId))
      .returning();
    if (attachmentIds !== undefined) {
      await claimAttachmentsForComment(tx, { ticketId, commentId, attachmentIds, replace: true });
    }
    return row;
  });
  const reactionRows = await db.select().from(commentReactions).where(eq(commentReactions.commentId, commentId));
  const byEmoji = new Map<string, string[]>();
  for (const r of reactionRows) {
    const actorIds = byEmoji.get(r.emoji);
    if (actorIds) actorIds.push(r.actorId);
    else byEmoji.set(r.emoji, [r.actorId]);
  }
  return {
    ...updated,
    reactions: Array.from(byEmoji.entries()).map(([emoji, actorIds]): CommentReactionSummary => ({ emoji, actorIds })),
    attachments: await listCommentAttachments(db, commentId),
  };
}

/**
 * Author-only delete (ROAD-162) — same enforcement shape as editComment
 * above, for the same reason. A real delete, not a soft one: `parentId`'s
 * `onDelete: 'set null'` (schema/tickets.ts) means any reply left under
 * this comment becomes its own root in the thread view rather than
 * vanishing with it — see that column's own comment.
 */
export async function deleteComment(ticketId: string, commentId: string) {
  await assertTicketInWorkspace(ticketId);
  const existing = await getCommentOrThrow(ticketId, commentId);
  if (existing.authorId !== currentMemberId()) {
    throw new ForbiddenError('Only the comment author can delete this comment.');
  }
  // ROAD-162: a comment's OWN attachments go with it — those files were
  // part of the thing being removed, unlike an orphaned reply (which is
  // somebody else's content and survives, see above). Rows are deleted
  // explicitly rather than left to commentId's cascade, because a cascade
  // cannot unlink a file and a file with no row is unreachable forever.
  const orphanedFileIds = await db.transaction(async (tx) => {
    const fileIds = await deleteAttachmentsForComment(tx, commentId);
    await tx.delete(comments).where(eq(comments.id, commentId));
    if (fileIds.length > 0) await recomputeAttachmentCount(tx, ticketId);
    return fileIds;
  });
  // After the commit, never inside it: an unlink cannot be rolled back, so
  // doing it first would destroy the bytes of rows a later rollback keeps.
  for (const fileId of orphanedFileIds) {
    await deleteAttachmentFile(fileId);
  }
}

// A reaction emoji only ever arrives here from the frontend's own curated
// picker (jiraCommentEmoji.ts's ~90-entry list, reused rather than
// duplicated — see that file's own comment), never free text a person
// types — but the route parameter is still just a string over HTTP, so this
// is defense-in-depth against something absurd (a multi-kilobyte value)
// landing in the table, not an attempt to re-validate against that exact
// curated list server-side (which would couple this service to a frontend
// data file for no real safety gain: an unrecognized-but-short emoji string
// is harmless, just not one the picker currently offers).
const MAX_EMOJI_LENGTH = 16;

/**
 * Toggles the current member's reaction to one comment: adds it if they
 * haven't reacted with this exact emoji yet, removes it if they have.
 * Anyone who can see the ticket may react — unlike edit/delete, this is
 * intentionally NOT author-gated (a reaction is closer to a lightweight
 * ack than an edit right).
 *
 * Returns the comment's full, freshly-read reaction summary (not just the
 * one emoji that changed) so the caller can replace its local state
 * wholesale rather than hand-patching a count — the same "trust the
 * response" pattern editComment/addComment already follow.
 */
export async function toggleCommentReaction(
  ticketId: string,
  commentId: string,
  emoji: string,
): Promise<CommentReactionSummary[]> {
  await assertTicketInWorkspace(ticketId);
  await getCommentOrThrow(ticketId, commentId);
  if (emoji.length === 0 || emoji.length > MAX_EMOJI_LENGTH) {
    throw new ValidationError('emoji must be between 1 and 16 characters');
  }
  const actorId = currentMemberId();
  const [existing] = await db
    .select()
    .from(commentReactions)
    .where(
      and(
        eq(commentReactions.commentId, commentId),
        eq(commentReactions.actorId, actorId),
        eq(commentReactions.emoji, emoji),
      ),
    );
  if (existing) {
    await db.delete(commentReactions).where(eq(commentReactions.id, existing.id));
  } else {
    // The (commentId, actorId, emoji) unique constraint (schema/tickets.ts)
    // is what makes this race-safe: two near-simultaneous toggles from the
    // same actor either both see `existing` (and both delete — the second
    // delete is a no-op) or the second insert loses the race and violates
    // the constraint, which surfaces as a 409 (errorHandler.ts's 23505
    // mapping) rather than a silent double-reaction.
    await db.insert(commentReactions).values({ id: newId('rx'), commentId, actorId, emoji });
  }
  const rows = await db.select().from(commentReactions).where(eq(commentReactions.commentId, commentId));
  const byEmoji = new Map<string, string[]>();
  for (const r of rows) {
    const actorIds = byEmoji.get(r.emoji);
    if (actorIds) actorIds.push(r.actorId);
    else byEmoji.set(r.emoji, [r.actorId]);
  }
  return Array.from(byEmoji.entries()).map(([e, actorIds]) => ({ emoji: e, actorIds }));
}
