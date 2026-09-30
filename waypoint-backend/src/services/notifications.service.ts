import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { members, notifications, tickets } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { findMentionedMemberIds } from '../lib/mentions.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function listNotifications() {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientId, currentMemberId()))
    .orderBy(desc(notifications.createdAt));
}

// AT11 (ROAD-146) sixth review round: took a bare id with no recipient
// check — any signed-in member could mark another member's notification
// read, matching listNotifications' own scoping instead of leaving it
// unscoped.
export async function markNotificationRead(id: string) {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, id), eq(notifications.recipientId, currentMemberId())));
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
    .select({ title: tickets.title })
    .from(tickets)
    .where(eq(tickets.id, input.ticketId));

  await tx.insert(notifications).values(
    recipients.map((recipientId) => ({
      id: newId('nt'),
      recipientId,
      actorId,
      ticketId: input.ticketId,
      // Same shape as the messages the notifications page already renders.
      message: `mentioned you on "${ticket?.title ?? 'a ticket'}"`,
      kind: 'mention' as const,
    })),
  );
}
