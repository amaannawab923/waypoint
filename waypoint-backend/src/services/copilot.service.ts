import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { copilotConversations, copilotMessages } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';

export async function getOrCreateConversation(memberId: string) {
  // Insert-first, not select-then-insert: the latter is a classic
  // check-then-act race — two near-simultaneous first requests for the
  // same member (e.g. a panel firing GET and POST together on first open)
  // could both see "no existing row" and both insert, silently splitting
  // that member's history across two conversations with no way to tell
  // which one is "the" conversation afterward. onConflictDoNothing against
  // the unique memberId index makes this atomic: at most one row can ever
  // exist per member, enforced by Postgres, not by application timing.
  //
  // target is explicit, not left bare: an untargeted ON CONFLICT DO
  // NOTHING matches *any* unique/PK violation, so it would also silently
  // swallow a (vanishingly unlikely, but real) id collision, or any other
  // unique constraint this table ever gains later — either would return no
  // row here with no error, and the route's destructuring would throw a
  // confusing TypeError instead of failing in a way anyone could diagnose.
  await db
    .insert(copilotConversations)
    .values({ id: newId('conv'), memberId })
    .onConflictDoNothing({ target: copilotConversations.memberId });
  const [conversation] = await db
    .select()
    .from(copilotConversations)
    .where(eq(copilotConversations.memberId, memberId))
    .limit(1);
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
    await tx
      .update(copilotConversations)
      .set({ updatedAt: new Date() })
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
