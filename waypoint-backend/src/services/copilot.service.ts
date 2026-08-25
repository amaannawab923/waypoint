import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { copilotConversations, copilotMessages } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';

// Placeholder for the real LLM integration landing in issue #7 — lets the
// persistence layer (this file), the route, and the frontend chat loop all
// get built and verified end-to-end without an LLM dependency yet.
const CANNED_REPLIES = [
  "Got it — I'll look into that.",
  "Thanks for the context, noted.",
  "I can help with that once I'm wired up to look at real ticket data.",
];

function nextCannedReply(): string {
  return CANNED_REPLIES[Math.floor(Math.random() * CANNED_REPLIES.length)];
}

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

export async function postMessage(conversationId: string, content: string) {
  return db.transaction(async (tx) => {
    await tx.insert(copilotMessages).values({
      id: newId('msg'),
      conversationId,
      role: 'user',
      content,
    });
    const [reply] = await tx
      .insert(copilotMessages)
      .values({
        id: newId('msg'),
        conversationId,
        role: 'assistant',
        content: nextCannedReply(),
      })
      .returning();
    await tx
      .update(copilotConversations)
      .set({ updatedAt: new Date() })
      .where(eq(copilotConversations.id, conversationId));
    return reply;
  });
}
