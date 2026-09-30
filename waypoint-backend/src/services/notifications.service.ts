import { and, eq, inArray, isNull, lt, lte, ne, notExists, or, sql, count } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { members, notifications, tickets } from '../db/schema/index.js';
import type { NotificationPayload } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { findMentionedMemberIds } from '../lib/mentions.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';
import { ValidationError } from '../middleware/errors.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = typeof notifications.$inferSelect;

/** Which kinds each tab shows. `all` is unfiltered. */
export const NOTIFICATION_TABS = {
  all: null,
  mentions: ['mention', 'reply'],
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
// ROAD-162: producing notifications from comments.
//
// Until this existed, nothing outside db/seed.ts ever wrote a notification
// row. The comment composer's "@" picker searched real members and inserted
// "@Name" with every signal of a directed-attention feature, and delivered
// nothing: exactly the UI-that-implies-what-the-system-doesn't-do this
// product has a standing rule against. The table, the routes and the bell
// were all already in place; this is the missing write half.
// ---------------------------------------------------------------------------

/**
 * Writes the mention notifications one comment produces, inside the
 * caller's transaction: a notification that exists for a comment which
 * rolled back would point at nothing.
 *
 *  - Every member the body @mentions gets a `mention`. On an EDIT, only names
 *    that were not already in the previous body: fixing a typo must not
 *    re-notify everyone the comment already mentioned.
 *  - Never the actor. Mentioning yourself is not news.
 *  - Honors the recipient's own "Notify on mentions" preference
 *    (members.notificationPrefs.mentions). Unset means the settings page's
 *    default, which is on.
 *  - Recipients are members of the current workspace only (the lookup below
 *    enforces it), so a crafted "@Name" can never reach another workspace.
 *
 * Replies deliberately do NOT notify the parent comment's author yet. The
 * only related setting ("Notify on comments") is worded as comments on a
 * ticket you created or are assigned to, which a reply to your comment is
 * not. Routing replies through it would make that setting describe
 * something it doesn't do. Reply notifications need their own setting
 * first.
 */
export async function notifyMentionsInComment(
  tx: Tx,
  input: {
    ticketId: string;
    body: string;
    /** The comment the mention is in: the row deep-links to it. */
    commentId: string;
    /** Set on an edit: mentions already present here are not re-sent. */
    previousBody?: string;
  },
): Promise<void> {
  const actorId = currentMemberId();
  const workspaceMembers = await tx
    .select({
      id: members.id,
      displayName: members.displayName,
      notificationPrefs: members.notificationPrefs,
    })
    .from(members)
    .where(eq(members.workspaceId, currentWorkspaceId()));

  const already = new Set(
    input.previousBody !== undefined
      ? findMentionedMemberIds(input.previousBody, workspaceMembers)
      : [],
  );
  const prefsById = new Map(workspaceMembers.map((m) => [m.id, m.notificationPrefs]));
  const recipients = findMentionedMemberIds(input.body, workspaceMembers).filter((id) => {
    if (id === actorId || already.has(id)) return false;
    const prefs = prefsById.get(id) as { mentions?: boolean } | null | undefined;
    return prefs?.mentions !== false;
  });
  if (recipients.length === 0) return;

  const [ticket] = await tx
    .select({ title: tickets.title, identifier: tickets.identifier })
    .from(tickets)
    .where(eq(tickets.id, input.ticketId));
  // Display snapshot only; the client renders the sentence from it.
  const payload: NotificationPayload = {
    v: 1,
    ...(ticket ? { ticketKey: ticket.identifier, ticketTitle: ticket.title } : {}),
  };

  await tx
    .insert(notifications)
    .values(
      recipients.map((recipientId) => ({
        id: newId('nt'),
        recipientId,
        actorId,
        ticketId: input.ticketId,
        commentId: input.commentId,
        kind: 'mention' as const,
        // One open row per (recipient, comment): an edit that re-adds a name
        // while the first notification is still unread doesn't stack a
        // second row (see notifications_open_group_uq).
        groupKey: `mention:${input.commentId}`,
        payload,
      })),
    )
    .onConflictDoNothing();
}
