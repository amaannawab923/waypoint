import { and, eq, inArray, isNull, lt, lte, ne, notExists, or, sql, count } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { comments, members, notifications, ticketAssignees, tickets } from '../db/schema/index.js';
import type { NotificationPayload } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { findMentionedMemberIds } from '../lib/mentions.js';
import { commentSnippet } from '../lib/commentSnippet.js';
import { assertTicketInWorkspace } from '../lib/workspaceGuard.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';
import { ValidationError } from '../middleware/errors.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = typeof notifications.$inferSelect;

/** Which kinds each tab shows. `all` is unfiltered. */
export const NOTIFICATION_TABS = {
  all: null,
  mentions: ['mention', 'reply'],
  assigned: ['assigned'],
  sessions: ['agent_blocked', 'agent_needs_review'],
} as const satisfies Record<string, readonly Row['kind'][] | null>;
export type NotificationTab = keyof typeof NOTIFICATION_TABS;

export const NOTIFICATION_PAGE_MAX = 100;

// ---------------------------------------------------------------------------
// Keyset cursor over (updated_at, id) DESC.
//
// Same reasoning as agentRuns.service.ts's run cursor: a JS Date holds
// milliseconds and updated_at holds microseconds, so the cursor carries the
// column's own text rendering and compares it as a timestamptz. A cursor
// built from toISOString() would skip every row sharing the boundary
// millisecond.
// ---------------------------------------------------------------------------
const CURSOR_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export interface NotificationCursor {
  /** `updated_at::text` exactly as Postgres renders it. */
  updatedAt: string;
  id: string;
}

export function encodeNotificationCursor(c: NotificationCursor): string {
  return Buffer.from(JSON.stringify({ u: c.updatedAt, i: c.id }), 'utf8').toString('base64url');
}

export function decodeNotificationCursor(raw: string): NotificationCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { u: unknown; i: unknown };
    if (typeof parsed.u !== 'string' || !CURSOR_TEXT.test(parsed.u) || typeof parsed.i !== 'string' || !parsed.i) {
      throw new Error('malformed');
    }
    return { updatedAt: parsed.u, id: parsed.i };
  } catch {
    throw new ValidationError('invalid cursor');
  }
}

/** The shape the API returns: the row plus a derived `read`, and the row's own cursor. */
function toItem(row: Row, updatedAtText: string) {
  return { ...row, read: row.readAt !== null, cursor: encodeNotificationCursor({ updatedAt: updatedAtText, id: row.id }) };
}

function tabCondition(tab: NotificationTab) {
  const kinds = NOTIFICATION_TABS[tab];
  return kinds ? inArray(notifications.kind, [...kinds]) : undefined;
}

/** Rows strictly older than the cursor, in (updated_at, id) DESC order. */
function olderThan(c: NotificationCursor) {
  const at = sql`${c.updatedAt}::timestamptz`;
  return or(lt(notifications.updatedAt, at), and(eq(notifications.updatedAt, at), lt(notifications.id, c.id)))!;
}

/** Rows at or older than the cursor: the cursor row itself included. */
function atOrOlderThan(c: NotificationCursor) {
  const at = sql`${c.updatedAt}::timestamptz`;
  return or(lt(notifications.updatedAt, at), and(eq(notifications.updatedAt, at), lte(notifications.id, c.id)))!;
}

export async function countUnreadNotifications(): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.recipientId, currentMemberId()), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/**
 * One page of the current member's notifications, newest first. Always
 * scoped to the caller: there is no way to ask for someone else's.
 */
export async function listNotifications(query: {
  tab?: NotificationTab;
  unreadOnly?: boolean;
  limit?: number;
  cursor?: string;
} = {}) {
  const limit = Math.min(Math.max(query.limit ?? 30, 1), NOTIFICATION_PAGE_MAX);
  const conditions = [eq(notifications.recipientId, currentMemberId())];
  const byTab = tabCondition(query.tab ?? 'all');
  if (byTab) conditions.push(byTab);
  if (query.unreadOnly) conditions.push(isNull(notifications.readAt));
  if (query.cursor) conditions.push(olderThan(decodeNotificationCursor(query.cursor)));

  const rows = await db
    .select({ row: notifications, updatedAtText: sql<string>`${notifications.updatedAt}::text` })
    .from(notifications)
    .where(and(...conditions))
    // Spelled NULLS LAST to match notifications_recipient_updated_idx
    // exactly; a bare DESC means NULLS FIRST, which Postgres won't serve from
    // that index, so every page would read and sort all of the recipient's
    // rows.
    .orderBy(sql`${notifications.updatedAt} desc nulls last`, sql`${notifications.id} desc nulls last`)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((r) => toItem(r.row, r.updatedAtText));
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? last.cursor : null,
    unreadCount: await countUnreadNotifications(),
  };
}

// AT11 (ROAD-146) sixth review round: took a bare id with no recipient
// check — any signed-in member could mark another member's notification
// read, matching listNotifications' own scoping instead of leaving it
// unscoped. The same recipient filter guards every write below.
export async function markNotificationRead(id: string) {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.recipientId, currentMemberId()),
        isNull(notifications.readAt),
      ),
    );
}

const openSibling = alias(notifications, 'open_sibling');

/**
 * Marks a row unread again — unless its group already has a newer open row
 * (e.g. a mention that was read, then re-sent by an edit). Two open rows in
 * one group would violate notifications_open_group_uq, and the group is
 * already unread anyway, so that case is a quiet no-op, not a 409.
 */
export async function markNotificationUnread(id: string) {
  await db
    .update(notifications)
    .set({ readAt: null })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.recipientId, currentMemberId()),
        or(
          isNull(notifications.groupKey),
          notExists(
            db
              .select({ one: sql`1` })
              .from(openSibling)
              .where(
                and(
                  eq(openSibling.recipientId, notifications.recipientId),
                  eq(openSibling.groupKey, notifications.groupKey),
                  isNull(openSibling.readAt),
                  ne(openSibling.id, notifications.id),
                ),
              ),
          ),
        ),
      ),
    );
}

/**
 * Marks every unread notification in a tab read — but only up to `before`,
 * the newest row the caller has actually loaded. A notification that
 * arrives while you're reading the list is newer than that, so it stays
 * unread instead of being cleared unseen.
 */
export async function markAllNotificationsRead(input: { tab?: NotificationTab; before: string }) {
  const bound = decodeNotificationCursor(input.before);
  const conditions = [
    eq(notifications.recipientId, currentMemberId()),
    isNull(notifications.readAt),
    atOrOlderThan(bound),
  ];
  const byTab = tabCondition(input.tab ?? 'all');
  if (byTab) conditions.push(byTab);
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...conditions))
    .returning({ id: notifications.id });
  return { updated: updated.length };
}

// ---------------------------------------------------------------------------
// Producers.
//
// Every producer runs inside the caller's transaction: a notification for a
// comment or an assignment that rolled back would point at nothing. Every
// recipient is a member of the CURRENT workspace (resolved through the
// members table), never the person who acted, and each kind honors its own
// setting on members.notificationPrefs, unset meaning the default below.
// ---------------------------------------------------------------------------

/**
 * What an unset preference means. The settings page
 * (renderer/pages/profile-settings/Notifications.tsx, DEFAULT_PREFS) shows
 * the same defaults; change both together.
 */
export const NOTIFICATION_PREF_DEFAULTS = {
  mentions: true,
  replies: true,
  comments: true,
  assignments: true,
} as const;
type PrefKey = keyof typeof NOTIFICATION_PREF_DEFAULTS;

function wants(prefs: unknown, key: PrefKey): boolean {
  const value = (prefs as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'boolean' ? value : NOTIFICATION_PREF_DEFAULTS[key];
}

async function workspaceMembers(tx: Tx) {
  return tx
    .select({ id: members.id, displayName: members.displayName, notificationPrefs: members.notificationPrefs })
    .from(members)
    .where(eq(members.workspaceId, currentWorkspaceId()));
}

/** The display snapshot every ticket-scoped row carries. */
async function ticketPayload(tx: Tx, ticketId: string) {
  const [ticket] = await tx
    .select({
      title: tickets.title,
      identifier: tickets.identifier,
      projectId: tickets.projectId,
      createdById: tickets.createdById,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  const payload: NotificationPayload = ticket
    ? { v: 1, ticketKey: ticket.identifier, ticketTitle: ticket.title, projectId: ticket.projectId }
    : { v: 1 };
  return { ticket, payload };
}

/**
 * Everything one comment notifies, at most once per person, strongest
 * reason first:
 *
 *  1. `mention` — members the body @mentions (on an edit, only names the
 *     edit added; fixing a typo must not re-notify anyone).
 *  2. `reply` — the author of the comment this one replies to.
 *  3. `comment` — the ticket's followers: its creator, its member
 *     assignees, and everyone who has commented on it before. One unread
 *     row per ticket per person: a later comment while it's unread folds
 *     into it ("X and 2 others commented…") instead of adding a row.
 *
 * Someone reached by a stronger reason is never also reached by a weaker
 * one, even if they've turned the stronger kind off — "don't tell me when
 * I'm mentioned" must not turn into "tell me about the comment instead".
 * Edits only ever produce mentions.
 */
export async function notifyForComment(
  tx: Tx,
  input: {
    ticketId: string;
    /** The comment: rows deep-link to it (#comment-<id>). */
    commentId: string;
    body: string;
    /** The comment it replies to, if any (new comments only). */
    parentId?: string | null;
    /** Set on an edit: mentions already present here are not re-sent. */
    previousBody?: string;
  },
): Promise<void> {
  const actorId = currentMemberId();
  const isEdit = input.previousBody !== undefined;
  const people = await workspaceMembers(tx);
  const prefsById = new Map(people.map((m) => [m.id, m.notificationPrefs]));
  const { ticket, payload: base } = await ticketPayload(tx, input.ticketId);
  const snippet = commentSnippet(input.body);
  // snippetCommentId: which comment the quoted words came from, so deleting
  // or editing that comment can take them back out (forgetComment,
  // refreshCommentSnippet below).
  const payload: NotificationPayload = {
    ...base,
    ...(snippet ? { snippet } : {}),
    snippetCommentId: input.commentId,
  };
  // Everyone already accounted for: the actor, then each tier's audience.
  const reached = new Set<string>([actorId]);

  // 1. Mentions.
  const already = new Set(isEdit ? findMentionedMemberIds(input.previousBody!, people) : []);
  const mentioned = findMentionedMemberIds(input.body, people).filter((id) => !reached.has(id));
  const mentionRecipients = mentioned.filter((id) => !already.has(id) && wants(prefsById.get(id), 'mentions'));
  if (mentionRecipients.length > 0) {
    await tx
      .insert(notifications)
      .values(
        mentionRecipients.map((recipientId) => ({
          id: newId('nt'),
          recipientId,
          actorId,
          ticketId: input.ticketId,
          commentId: input.commentId,
          kind: 'mention' as const,
          // The wall clock, not the transaction's start: see the upsert below.
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
          // One open row per (recipient, comment): an edit that re-adds a
          // name while the first notification is still unread doesn't stack
          // a second row (see notifications_open_group_uq).
          groupKey: `mention:${input.commentId}`,
          payload,
        })),
      )
      .onConflictDoNothing();
  }
  for (const id of mentioned) reached.add(id);
  if (isEdit) return;

  // 2. The author of the comment being replied to.
  if (input.parentId) {
    const [parent] = await tx
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(and(eq(comments.id, input.parentId), eq(comments.ticketId, input.ticketId)));
    const author = parent?.authorId;
    if (author && prefsById.has(author) && !reached.has(author)) {
      if (wants(prefsById.get(author), 'replies')) {
        await tx
          .insert(notifications)
          .values({
            id: newId('nt'),
            recipientId: author,
            actorId,
            ticketId: input.ticketId,
            commentId: input.commentId,
            kind: 'reply',
            // The wall clock, not the transaction's start: see the upsert below.
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
            groupKey: `reply:${input.commentId}`,
            payload,
          })
          .onConflictDoNothing();
      }
      reached.add(author);
    }
  }

  // 3. The ticket's followers, grouped per ticket while unread.
  if (!ticket) return;
  const assignees = await tx
    .select({ id: ticketAssignees.assigneeId })
    .from(ticketAssignees)
    .where(and(eq(ticketAssignees.ticketId, input.ticketId), eq(ticketAssignees.assigneeKind, 'member')));
  const commenters = await tx
    .selectDistinct({ id: comments.authorId })
    .from(comments)
    .where(and(eq(comments.ticketId, input.ticketId), ne(comments.id, input.commentId)));
  const followers = new Set([ticket.createdById, ...assignees.map((a) => a.id), ...commenters.map((c) => c.id)]);
  const commentRecipients = [...followers].filter(
    (id) => prefsById.has(id) && !reached.has(id) && wants(prefsById.get(id), 'comments'),
  );
  if (commentRecipients.length === 0) return;
  // One statement for every follower (they're distinct, so the upsert is
  // well-defined).
  await tx
    .insert(notifications)
    .values(
      commentRecipients.map((recipientId) => ({
        id: newId('nt'),
        recipientId,
        actorId,
        ticketId: input.ticketId,
        commentId: input.commentId,
        kind: 'comment' as const,
        // The wall clock, not the transaction's start: see the upsert below.
        createdAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
        groupKey: `comment:${input.ticketId}`,
        payload: { ...payload, actorIds: [actorId], count: 1 },
      })),
    )
    .onConflictDoUpdate({
      target: [notifications.recipientId, notifications.groupKey],
      targetWhere: sql`${notifications.readAt} IS NULL AND ${notifications.groupKey} IS NOT NULL`,
      // Fold into the open row:
      //  - comment_id is NOT overwritten: the row keeps pointing at the
      //    first comment the person hasn't seen, so opening it starts there.
      //  - the quote is the newest comment's (or none, for files only —
      //    never a JSON null), with snippetCommentId naming its comment.
      //  - distinct actors and the count accumulate.
      //  - updated_at never moves backwards: now() is the transaction's
      //    START, which can predate a concurrent commit that already bumped
      //    this row; clock_timestamp() and greatest() keep the order true.
      set: {
        actorId: sql`excluded.actor_id`,
        updatedAt: sql`greatest(${notifications.updatedAt}, clock_timestamp())`,
        payload: sql`(${notifications.payload} - 'snippet' - 'snippetCommentId')
          || jsonb_strip_nulls(jsonb_build_object(
            'snippet', excluded.payload -> 'snippet',
            'snippetCommentId', excluded.payload -> 'snippetCommentId'
          ))
          || jsonb_build_object(
            'ticketTitle', excluded.payload -> 'ticketTitle',
            'count', COALESCE((${notifications.payload} ->> 'count')::int, 1) + 1,
            'actorIds', (
              SELECT COALESCE(jsonb_agg(DISTINCT a), '[]'::jsonb)
              FROM jsonb_array_elements(
                COALESCE(${notifications.payload} -> 'actorIds', '[]'::jsonb) || (excluded.payload -> 'actorIds')
              ) AS t(a)
            )
          )`,
      },
    });
}

/**
 * Assignment changes on one ticket. Newly added member assignees get an
 * `assigned` row (one open row per ticket per person); someone removed while
 * that row is still unread has it withdrawn — being assigned and unassigned
 * by accident isn't news. Agents are never recipients.
 */
export async function notifyAssignmentChanges(
  tx: Tx,
  input: { ticketId: string; added: string[]; removed: string[]; created?: boolean },
): Promise<void> {
  const actorId = currentMemberId();
  const groupKey = `assigned:${input.ticketId}`;
  const removed = input.removed.filter((id) => !id.startsWith('agent-'));
  if (removed.length > 0) {
    await tx
      .delete(notifications)
      .where(
        and(
          inArray(notifications.recipientId, removed),
          eq(notifications.groupKey, groupKey),
          isNull(notifications.readAt),
        ),
      );
  }
  const candidates = input.added.filter((id) => !id.startsWith('agent-') && id !== actorId);
  if (candidates.length === 0) return;
  const people = await workspaceMembers(tx);
  const prefsById = new Map(people.map((m) => [m.id, m.notificationPrefs]));
  const recipients = candidates.filter((id) => prefsById.has(id) && wants(prefsById.get(id), 'assignments'));
  if (recipients.length === 0) return;
  const { payload } = await ticketPayload(tx, input.ticketId);
  await tx
    .insert(notifications)
    .values(
      recipients.map((recipientId) => ({
        id: newId('nt'),
        recipientId,
        actorId,
        ticketId: input.ticketId,
        kind: 'assigned' as const,
        // The wall clock, not the transaction's start: see the upsert below.
        createdAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
        groupKey,
        payload: { ...payload, ...(input.created ? { created: true } : {}) },
      })),
    )
    .onConflictDoNothing();
}

/**
 * Opening a ticket clears what it was about: the caller's unread mention,
 * reply, comment and assignment rows on that ticket are marked read.
 */
export async function markNotificationsReadForTicket(ticketId: string): Promise<{ updated: number }> {
  await assertTicketInWorkspace(ticketId);
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.recipientId, currentMemberId()),
        eq(notifications.ticketId, ticketId),
        isNull(notifications.readAt),
        inArray(notifications.kind, ['mention', 'reply', 'comment', 'assigned']),
      ),
    )
    .returning({ id: notifications.id });
  return { updated: updated.length };
}

/**
 * A comment is being deleted: nothing it said may outlive it in anyone's
 * notifications. Runs in the delete's transaction, before the row goes (so
 * comment_id still matches — the FK's SET NULL comes after). Every
 * statement is scoped to the ticket, which the notifications_ticket_idx
 * index serves, so this doesn't grow with the whole table.
 *
 *  - Unread mention/reply rows about it are withdrawn: there's nothing left
 *    to open.
 *  - An unread grouped `comment` row that was only about it is withdrawn;
 *    one that opens at it but covers later comments counts one fewer and
 *    opens at the next of them; one whose run merely includes it counts one
 *    fewer.
 *  - Any row still quoting it (a newer grouped row, a read mention kept as
 *    history) loses the quote.
 */
export async function forgetComment(tx: Tx, input: { ticketId: string; commentId: string }): Promise<void> {
  const { ticketId, commentId } = input;
  const aboutIt = and(eq(notifications.ticketId, ticketId), eq(notifications.commentId, commentId), isNull(notifications.readAt));
  await tx.delete(notifications).where(and(aboutIt, inArray(notifications.kind, ['mention', 'reply'])));
  await tx
    .delete(notifications)
    .where(and(aboutIt, eq(notifications.kind, 'comment'), sql`COALESCE((${notifications.payload} ->> 'count')::int, 1) <= 1`));
  await tx
    .update(notifications)
    .set({
      payload: sql`${notifications.payload} || jsonb_build_object('count', COALESCE((${notifications.payload} ->> 'count')::int, 1) - 1)`,
      commentId: sql`(
        SELECT c.id FROM ${comments} c
        WHERE c.ticket_id = ${ticketId} AND c.id <> ${commentId}
          AND c.created_at >= (SELECT created_at FROM ${comments} WHERE id = ${commentId})
        ORDER BY c.created_at, c.id
        LIMIT 1
      )`,
    })
    .where(and(aboutIt, eq(notifications.kind, 'comment')));
  // Grouped rows that began earlier but include this comment in their run
  // (it came after the comment they open at, from someone other than their
  // recipient) count one fewer.
  await tx
    .update(notifications)
    .set({
      payload: sql`${notifications.payload} || jsonb_build_object('count', GREATEST(COALESCE((${notifications.payload} ->> 'count')::int, 1) - 1, 1))`,
    })
    .where(
      and(
        eq(notifications.ticketId, ticketId),
        eq(notifications.kind, 'comment'),
        isNull(notifications.readAt),
        ne(notifications.commentId, commentId),
        sql`${notifications.recipientId} <> (SELECT author_id FROM ${comments} WHERE id = ${commentId})`,
        sql`(SELECT created_at FROM ${comments} WHERE id = ${notifications.commentId})
            <= (SELECT created_at FROM ${comments} WHERE id = ${commentId})`,
      ),
    );
  await tx
    .update(notifications)
    .set({ payload: sql`${notifications.payload} - 'snippet'` })
    .where(and(eq(notifications.ticketId, ticketId), sql`${notifications.payload} ->> 'snippetCommentId' = ${commentId}`));
}

/** A comment was edited: rows quoting it quote the new words. */
export async function refreshCommentSnippet(
  tx: Tx,
  input: { ticketId: string; commentId: string; body: string },
): Promise<void> {
  const snippet = commentSnippet(input.body);
  await tx
    .update(notifications)
    .set({
      payload: snippet
        ? sql`${notifications.payload} || jsonb_build_object('snippet', ${snippet}::text)`
        : sql`${notifications.payload} - 'snippet'`,
    })
    .where(
      and(
        eq(notifications.ticketId, input.ticketId),
        sql`${notifications.payload} ->> 'snippetCommentId' = ${input.commentId}`,
      ),
    );
}

/**
 * Someone left a project, taking their assignments on its tickets with them
 * (projects.service.ts removes those ticket_assignees rows directly, not
 * through logAssigneeChanges): withdraw their still-unread "assigned you"
 * rows for that project, the same rule an ordinary unassign follows.
 */
export async function withdrawAssignmentsInProject(tx: Tx, memberId: string, projectId: string): Promise<void> {
  await tx
    .delete(notifications)
    .where(
      and(
        eq(notifications.recipientId, memberId),
        eq(notifications.kind, 'assigned'),
        isNull(notifications.readAt),
        inArray(
          notifications.ticketId,
          tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, projectId)),
        ),
      ),
    );
}
