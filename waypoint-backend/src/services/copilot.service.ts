import { eq, asc, desc, count, and, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentRuns, copilotConversations, copilotMessages } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { truncateTitle } from '../lib/text.js';
import { NotFoundError } from '../middleware/errors.js';

export async function createConversation(memberId: string) {
  // A plain insert, no conflict handling — memberId isn't unique (issue
  // #11), so there's no constraint left to conflict against. title is left
  // unset here; it takes the schema's own default and is upgraded in place
  // by postUserMessage once the conversation's first message exists.
  const [conversation] = await db
    .insert(copilotConversations)
    .values({ id: newId('conv'), memberId })
    .returning();
  return conversation;
}

export async function listConversations(memberId: string) {
  return db
    .select()
    .from(copilotConversations)
    .where(eq(copilotConversations.memberId, memberId))
    .orderBy(desc(copilotConversations.updatedAt));
}

export async function getConversation(id: string) {
  const [conversation] = await db
    .select()
    .from(copilotConversations)
    .where(eq(copilotConversations.id, id))
    .limit(1);
  if (!conversation) throw new NotFoundError('conversation');
  return conversation;
}

// Bare delete, no existence pre-check — idempotent, matches this backend's
// existing delete convention (see states.service.ts's deleteState,
// scratchNotes.service.ts's deleteScratchNote). Messages cascade via the
// existing FK.
export async function deleteConversation(id: string) {
  await db.delete(copilotConversations).where(eq(copilotConversations.id, id));
}

export async function renameConversation(id: string, title: string) {
  const [conversation] = await db
    .update(copilotConversations)
    .set({ title, updatedAt: new Date() })
    .where(eq(copilotConversations.id, id))
    .returning();
  if (!conversation) throw new NotFoundError('conversation');
  return conversation;
}

export async function listMessages(conversationId: string) {
  return db
    .select()
    .from(copilotMessages)
    .where(eq(copilotMessages.conversationId, conversationId))
    .orderBy(asc(copilotMessages.seq));
}

// Split from a single postMessage() (issue #6) into two independent calls
// (issue #7): the assistant's reply now comes from a real, possibly
// multi-second, streamed Claude Code CLI subprocess orchestrated in the
// Electron main process — nothing this service can compute synchronously
// inside one request anymore. postUserMessage persists the user's turn the
// moment it's sent; postAssistantMessage persists the reply once the stream
// completes, which the caller invokes as a separate follow-up call.
export async function postUserMessage(conversationId: string, content: string) {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(copilotMessages)
      .values({
        id: newId('msg'),
        conversationId,
        role: 'user',
        content,
      })
      .returning();
    // Auto-title (issue #11), only on the conversation's first-ever message
    // — counted inside this same transaction so a concurrent second message
    // can't race past the check before this insert (and its title write)
    // commits. Unconditional once n === 1, unlike the old client-side
    // version's "only if still the untouched default" guard: a rename can
    // only happen after a conversation exists, and this only ever fires on
    // message #1 — there's no real flow where a rename could have already
    // landed by then.
    const [{ n }] = await tx
      .select({ n: count() })
      .from(copilotMessages)
      .where(eq(copilotMessages.conversationId, conversationId));
    await tx
      .update(copilotConversations)
      .set({
        updatedAt: new Date(),
        ...(n === 1 ? { title: truncateTitle(content) } : {}),
      })
      .where(eq(copilotConversations.id, conversationId));
    return message;
  });
}

// claudeSessionId is updated in the same transaction as the message insert,
// not a separate call: both are only ever known at the same instant (they
// come off the same `result` event at the end of the Claude Code stream), so
// there's no real atomicity boundary to draw between them.
//
// A null claudeSessionId is never written here, even though the parameter
// accepts one — it's only ever passed for a run that failed before reaching
// a `result` event, and this function isn't even called on a failed run (see
// CopilotPanel.tsx's runAndPersist, which routes that case to onError
// instead). If a caller ever does pass null for a conversation that already
// has a real session id, unconditionally writing it through would silently
// wipe that id, making the next message start a brand-new Claude Code
// session instead of continuing the existing one — with nothing in the UI
// to explain why Copilot suddenly "forgot" the conversation.
export async function postAssistantMessage(
  conversationId: string,
  content: string,
  claudeSessionId: string | null,
) {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(copilotMessages)
      .values({
        id: newId('msg'),
        conversationId,
        role: 'assistant',
        content,
      })
      .returning();
    await tx
      .update(copilotConversations)
      .set({
        updatedAt: new Date(),
        ...(claudeSessionId !== null ? { claudeSessionId } : {}),
      })
      .where(eq(copilotConversations.id, conversationId));
    return message;
  });
}

// ---------------------------------------------------------------------------
// W5a (ROAD-117): system notes — what Waypoint itself tells a conversation.
// ---------------------------------------------------------------------------

/**
 * The conversation a run's notes go to: the one it was dispatched from
 * when there was one, else the member's most recent. Null when the member
 * has no conversation at all — then there is nowhere to say it, and the
 * panel's badge and Review carry the news instead.
 */
export async function resolveNoteConversation(
  memberId: string,
  runId: string | null,
): Promise<string | null> {
  if (runId) {
    const [run] = await db
      .select({ conversationId: agentRuns.copilotConversationId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (run?.conversationId) return run.conversationId;
  }
  const [latest] = await db
    .select({ id: copilotConversations.id })
    .from(copilotConversations)
    .where(eq(copilotConversations.memberId, memberId))
    .orderBy(desc(copilotConversations.updatedAt))
    .limit(1);
  return latest?.id ?? null;
}

/** A note Waypoint wrote — built from the ledger, never by a model. Bumps the conversation so it surfaces. */
export async function postSystemNote(conversationId: string, content: string) {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: copilotConversations.id })
      .from(copilotConversations)
      .where(eq(copilotConversations.id, conversationId))
      .limit(1);
    if (!conversation) throw new NotFoundError('conversation');
    const [message] = await tx
      .insert(copilotMessages)
      .values({ id: newId('msg'), conversationId, role: 'system', content })
      .returning();
    await tx
      .update(copilotConversations)
      .set({ updatedAt: new Date() })
      .where(eq(copilotConversations.id, conversationId));
    return message;
  });
}

/** The notes the model has not been read yet, oldest first. */
export async function listUndeliveredNotes(conversationId: string) {
  return db
    .select()
    .from(copilotMessages)
    .where(
      and(
        eq(copilotMessages.conversationId, conversationId),
        eq(copilotMessages.role, 'system'),
        isNull(copilotMessages.deliveredAt),
      ),
    )
    .orderBy(asc(copilotMessages.seq));
}

/** Stamps the notes the model was read on a successful turn. Only system notes of this conversation. */
export async function markNotesDelivered(conversationId: string, ids: string[]): Promise<{ delivered: number }> {
  if (ids.length === 0) return { delivered: 0 };
  const rows = await db
    .update(copilotMessages)
    .set({ deliveredAt: new Date() })
    .where(
      and(
        eq(copilotMessages.conversationId, conversationId),
        eq(copilotMessages.role, 'system'),
        isNull(copilotMessages.deliveredAt),
        inArray(copilotMessages.id, ids),
      ),
    )
    .returning({ id: copilotMessages.id });
  return { delivered: rows.length };
}
